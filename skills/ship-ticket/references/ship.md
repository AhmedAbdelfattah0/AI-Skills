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
run record and in its artifact, because a check can be reused, grouped, untriggered
or degraded in ways a single rule row cannot.

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
constant, so a check that examined less than it should is a bug. Presentation may
aggregate rows already computed per rule — naming the IDs and the identical
detector, inputs, digest and result behind them. Evaluation may not: a
family-level detector standing in for per-rule evaluation is coverage loss.

Record, in the artifacts:

- the **companion mode** and every degraded check, by name
- the **orchestration mode of each wave** — recon and review; they can differ,
  and a run that fanned out its review while serializing an hour of recon is not
  a concurrent run
- **every manifest ID** and which is the accepted one
- **each check's outcome**, from the list above
- **each review pass's verified coverage** — the paths it reported reviewing,
  checked against the manifest, and any it was re-run for. The barrier verifies
  this transiently; recording it is what lets anyone later prove the diff was
  actually covered rather than take the barrier's word for it
- **the complete finding count first, at full severity** — then, separately, how
  many BUILD should have caught. **That classification never changes whether a
  finding is reported, its severity, or a verdict.** A high count is a BUILD
  problem to drive down, never a reason to report less
- **which `Par` groups actually ran concurrently**, and the reason for any that
  did not
- **which engine ran pass B**, at what effort, and whether it timed out
- the **plan critique's disposition**, and the **final `mutation_round`**
- per reference-backed screen: its grade, its signer, and the scope digest;
  per unreferenced one: its approver, date and search evidence
- the attack surfaces, the committed abuse tests, every class **degraded by ID**,
  and every changed file excluded and why
- every **skipped finding with its rule ID**, and every human-approved deviation
  with its approver and date
- the design files read and the pinned `design_ref`
- **phase timings** — start and end per phase, agent time kept separate from
  human-approval and CI wait, plus the overlap window of each intended parallel
  group

**Written so it survives the context.** "Tried to break the new endpoint — all
attacks refused" is recoverable months later; "GATE 5: PASS" is not. "Skipped some
findings that conflicted with our conventions" is worthless.

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
