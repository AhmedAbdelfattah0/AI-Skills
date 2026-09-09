# SHIP — one commit, one push, one wait

Loaded when the SHIP phase starts.

## Before the commit

**Write the run record and the session log first**, so they ride the single gated
commit rather than a second one. Run `/session-logger`, or write the entry
yourself to `session-log.md`; either way it must be on disk before the commit.

**Then recompute the manifest and verify the allowlist.** Every change since the
**accepted manifest** — the latest promoted `Fn`, or `F0` if no fixes were needed
— must be on the post-freeze allowlist. If code, tests or docs moved outside it,
that content is unreviewed and the wave must be re-run for it. ✋ STOP otherwise.

## The commit

**One commit, containing everything:**

- the code
- `.specs/plans/<TICKET>.md` — with its final `mutation_round`
- `.specs/design-parity/<TICKET>.md`
- `.specs/vapt/<TICKET>.md` **and the abuse tests it produced**
- the doc updates
- `session-log.md`

**Push it once.**

## The PR

Open it **on the repo's actual host** — Azure Repos via the ADO repo tools, or
GitHub via `gh`, per the tracker table in [understand.md](understand.md). Link the
ticket to the PR and report the URL.

Then wait **exactly once** for the CI checks to report.

**Do not poll or block on the PR-side review bots.** **Push nothing further unless
a gate actually fails and needs a code fix.** A doc-only commit pushed after the
checks go green re-triggers the entire CI and bot cycle from scratch — that
re-trigger is the waste this ordering exists to prevent.

## Closing the ticket

Transition it to **Done** only after the gate checks are green, using the
tracker's transition operation — the Jira workflow transition, or
`wit_update_work_item` to the work item type's resolved completed-category state.

Then tell the user the PR is open and ready to merge, and ask them to run
`/compact`. Both the merge and `/compact` are theirs; this skill does neither.

For UI tickets, the user is also the human approver of any accepted deviation.
