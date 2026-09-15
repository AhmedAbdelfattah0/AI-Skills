# SHIP — compact evidence, one commit, and external completion

Loaded when SHIP starts. REVIEW has already returned PASS for one exact candidate.

## Canonical outcome vocabulary

Every rule, proof and review row uses:

```text
OUTCOME_VOCABULARY
PASS             ran and satisfied every applicable condition
FAIL             did not pass and blocks completion
NOT_TRIGGERED    the detector proved the check's trigger false
NOT_APPLICABLE   a specific rule or comparator does not apply, with evidence
DEGRADED         reduced coverage ran and every omitted class/family is named
```

Execution detail may use FULL, REUSED, GROUPED or REDUCED. REDUCED accompanies
DEGRADED, never PASS. Blank, missing or unknown outcomes fail closed.

## The execution record

The approved plan ends with a delimited execution block. Append one UTF-8 JSON
object per event immediately before its end marker. Never edit or reorder an
existing object.

Every event carries run_id, event and timestamp. Use only these event names:

| Event | Required evidence |
|---|---|
| **START** | approved-plan digest, human approver and target base |
| **PROVE** | command outcomes, rule/test/docs/parity/VAPT evidence and degradations |
| **REVIEW** | profile, candidate ID, primary identity, optional identity/degradation, coverage, findings, dispositions and outcome |
| **REPAIR** | finding IDs, changed paths, affected closure, rerun commands and new candidate ID |
| **CONFIRM** | reviewer, candidate ID, checked findings/closure and outcome |
| **WAIT_FOR_USER** | phase, reason and the one action needed |
| **FAIL** | phase, terminal evidence and remaining work |
| **SHIP_READY** | reviewed candidate ID and approved-plan digest |

This is an execution summary, not a source archive. Do not store copied source
bytes, prose preimages, per-line timing chatter or duplicate findings. Persist
lists and derive counts when presenting them.

The local run log from [observability.md](observability.md) is the timing source
of truth. The committed execution block records compact outcomes and the run ID,
not duplicate timing chatter. A status message creates neither kind of event.

## Candidate identity

REVIEW computes the candidate ID with
scripts/candidate-id.mjs from the installed ship-ticket folder. It hashes the
final state of all changed and untracked candidate paths relative to the merge
base.

The command excludes:

- the plan artifact, whose approved narrative is protected by its separately
  recorded approved-plan digest;
- session-log.md, whose single predeclared entry is appended before commit.

Recompute with the same base and exclusions immediately before commit and on any
SHIP resume. A mismatch is FAIL because the candidate is no longer the one that
passed review.

## Before the commit

Confirm:

- the final REVIEW or CONFIRM event is PASS;
- the approved-plan digest still matches;
- the recomputed candidate ID matches the reviewed ID;
- every candidate path remains inside the Design Contract;
- all required locally runnable commands remain green or have unchanged reusable
  evidence;
- no unrelated user changes would enter the commit.

Append SHIP_READY and the one predeclared ticket-keyed session-log entry. Those two
recording writes are excluded from candidate identity. No code, test, comment,
documentation, parity or VAPT evidence may change after REVIEW PASS.

## One commit

The commit contains:

- implementation and tests;
- the approved plan and compact execution events;
- the UI parity artifact when UI is triggered;
- the VAPT artifact and committed abuse tests when a trust boundary is triggered;
- documentation changes;
- the ticket-keyed session-log entry.

Create one commit and push once. Do not create a WIP commit or amend later merely
to record external results.

Commit, push, PR, CI and tracker results do not exist before the commit. Report
them to the user and tracker as an external completion projection keyed by run ID
and candidate ID; do not write another repository commit to backfill them.

## Open and link the PR

Use the repository's actual host. For Azure Repos use its repository tools; for
GitHub use gh. Link the tracker item by its supported artifact link, development
panel integration or description/comment convention.

Wait for the CI commands enumerated from the repository configuration during
UNDERSTAND. Do not wait for optional PR review bots. A missing artifact-specific
check is a previously declared degradation, not a check to poll forever.

## CI and external failures

- A deterministic red CI result is FAIL. Do not mutate the reviewed commit or
  reopen REVIEW automatically.
- A host, network, rate-limit, PR-service, tracker-service or explicitly
  rerunnable CI infrastructure failure pauses only that external operation.
- On resume, recompute the same candidate ID, verify the approved-plan digest and
  inspect which idempotent operations already succeeded. Continue only the
  missing operation.

Reporting a transient failure is not completion. Use WAIT_FOR_USER only when the
user must provide credentials, permission or an external decision; otherwise
retry the bounded idempotent operation automatically.

## Complete the tracker item

Transition only after CI is green. Jira uses the workflow's real completion
transition. Azure DevOps uses the work-item type's completed-category state, which
may be Done, Closed or a custom name; never guess it.

Record the postcommit projection in the tracker when supported:

```text
run_id
candidate_id
commit
push outcome
PR URL
CI outcome
tracker transition
completion timestamp
ship outcome
```

Then report COMPLETE with the PR URL. The user owns merging the PR and any context
compaction request.
