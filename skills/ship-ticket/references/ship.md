# SHIP — the run record, one commit, one push, one wait

Loaded when the SHIP phase starts. The spine carries the two things that must be
done from phase 1: capture timings as you go, and declare the companion mode up
front.

## The run record — the full schema

**One schema, three consumers.** The user's report, the session log, and the
success criteria are the same facts — write them once. The user's version leads
with plain sentences; the log and artifacts carry the identifiers.

**Two vocabularies, at two levels. Do not mix them.**

A **rule row** inside the rule pass answers `PASS` / `FAIL` / `N-A` — that is a
verdict about one rule against one diff. A **check as a whole** — the rule pass,
the parity check, the attack testing — declares one of the outcomes below in the
one location determined by when it runs, because a check can be reused, grouped,
untriggered or degraded in ways a single rule row cannot. A pre-`F0` producer such
as VAPT records it in the frozen evidence artifact. A post-`F0` check records it
in the plan's run-state block and never writes back into a frozen artifact. The
user report and session log are projections of that canonical location; they do
not become competing sources of truth.

They map one way only: **any `FAIL` row makes its check `FAIL`.** A check may not
report `PASS_FULL` over a table containing a `FAIL` row.

Every check declares exactly one outcome:

```
PASS_FULL                          ran in full
PASS_REUSED                        deterministic output reused — name it and the digest
                                   it bound to. Never a semantic judgment
PASS_GROUPED                       shared test definitions — name them, and confirm every
                                   route was executed against them
FAIL                               did not pass. Blocks acceptance and close-out
NOT_TRIGGERED                      + detector name and version, the complete changed-file
                                   classification, and a digest of that output
NOT_APPLICABLE_NO_SCREEN_REFERENCE + approver, date, and reference-search evidence
DEGRADED                           + the classes that could not run, by ID
```

**A blank table, an omitted row, or a bare "N/A" is a FAIL.** Coverage is
applicability-driven, so a check that examined less than it should is a bug.
Presentation may aggregate rows already computed per rule — naming the IDs and
the identical detector, inputs, digest and result behind them. Evaluation may not:
a family-level detector standing in for per-rule evaluation is coverage loss.

### Path, frozen prefix and allowed later fields

This map replaces the former conceptual artifact list with exact storage and
mutation boundaries.

| Path | Frozen at `F0` | The only later writes |
|---|---|---|
| `.specs/plans/<TICKET>.md` | metadata, approved plan and Design Contract above `RUN-STATE:BEGIN` | JSON-lines entries appended between the existing run-state markers: `batches[]`, `reviewers[]`, `manifests[]`, `findings[]`, `dispositions[]`, `outcomes[]`, `timings[]`, `degradations[]` |
| `.specs/design-parity/<TICKET>.md` | the whole pre-`F0` evidence artifact | none; pass A and terminal parity results go to the plan's run-state block |
| `.specs/vapt/<TICKET>.md` | the whole runtime-evidence artifact | none; terminal attack/security outcomes go to the plan's run-state block |
| changed comments, docs and ticket-produced artifacts | the entire manifested content | none |
| `session-log.md` | all pre-existing entries | one new ticket-keyed entry in SHIP, derived from the run-state block; no earlier entry may change |

The run-state storage categories and repair-batch shape are defined in
[review.md](review.md); check outcomes use the enum above. The terminal verdict is
one `outcomes[]` entry with review.md's canonical verdict shape. The frozen
prefixes contain only pre-`F0` candidate claims; post-`F0` findings, dispositions
and reviewer conclusions belong in run state by design.

Across the frozen evidence and the plan's run-state block, record:

- companion degradations and orchestration mode;
- `F0`, the final candidate manifest and the frozen-record digest;
- round-1 reviewer identities and verified paths;
- finding IDs, dispositions and the fix-packet digest when barrier 1 repaired the
  candidate;
- terminal reviewer identity and every terminal sub-outcome;
- per reference-backed screen: round-1 grade, stable divergences, barrier-1
  impact slice and terminal parity outcome;
- per unreferenced screen: approver, date and search evidence;
- attack surfaces, named abuse tests, excluded files and degraded rule IDs;
- plan-critique dispositions and the append-only repair-batch entries;
- phase timings and concurrency windows.

Persist lists, not hand-maintained totals. Derive counts when presenting the
record.

**Written so it survives the context.** "Tried to break the new endpoint — all
attacks refused" is recoverable months later; "security gate: PASS" is not. "Skipped some
findings that conflicted with our conventions" is worthless.

## Before the commit

**Confirm the terminal verdict is already present in `outcomes[]`, then append only
the remaining SHIP timing/result entries and the session-log projection**, so they
ride the single gated commit rather than a second one. Run `/session-logger`, or
write the entry yourself to `session-log.md`; either way it must be on disk before
the commit.

**Then verify the frozen record and exact append slots.** The reviewed prefixes
must still match their digests. Every later byte must belong to the terminal
verdict, timing or session-log fields defined before `F0`. Any code, test,
comment, doc or narrative artifact change ends the run as unreviewed.

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

## The PR

Open it **on the repo's actual host** — Azure Repos via the ADO repo tools, or
GitHub via `gh`, per the tracker table in [understand.md](understand.md). Link the
ticket to the PR and report the URL.

Then wait exactly once for CI. Do not wait for PR-side review bots.

A CI failure leaves the run unshipped. A retry that changes no repository bytes
may rerun CI only. Any repository fix requires a new human-approved run; do not
push a repair and reopen REVIEW inside the completed run.

## Closing the ticket

Transition it to **Done** only after the gate checks are green, using the
tracker's transition operation — the Jira workflow transition, or
`wit_update_work_item` to the work item type's resolved completed-category state.

Then tell the user the PR is open and ready to merge, and ask them to run
`/compact`. Both the merge and `/compact` are theirs; this skill does neither.

For UI tickets, the user is also the human approver of any accepted deviation.
