# AIS-BENCH-1 Wave 2b - scenario results (S8, S9)

`scenarios.json` is script output, not edited by hand:
`node skills/ship-ticket/scripts/engine-bench.mjs --scenario all --json`, run alone on a quiet machine.

## Comparison with Wave 2

S1 to S7 equal `../wave-2/scenarios.json` in every field except `wall_ms` and `reference_bytes`
(checked field by field after removing those two). `reference_bytes` differs because the
reference files changed in this wave (N3 wording and the base-drift section); the orchestrator re-measures the load figures with `load-record.mjs`. S8 and S9 are new.

## S8 - evidence integrity (baseline, today's behaviour, nothing changed)

Driven through the real `run-engine.mjs gate review` CLI, one fresh world per row.

| Row | Refused | Recorded | What a record reader can reconstruct |
|---|---|---|---|
| Primary PASS, second-opinion minor finding disposed `fix` | `outcome_inconsistent` ("PASS with findings to fix") | nothing; the review chain stays empty | Only the refusal text. The second opinion's finding is in no record. |
| Primary PASS, second opinion FAIL, every finding `not applicable` | nothing; `review_accepted` | original record with outcome PASS, `second_opinion_route`, and the finding with its disposition | The route and the finding with `not applicable`. The second opinion's FAIL verdict is not recorded (no `second_opinion_outcome` on an original record; only confirmations carry it). |
| Same finding id in two executions | the second execution without an owner RETRY: `retry_unauthorized` | with an owner RETRY, both executions are recorded | Chain entries `rx-1:F1` and `rx-2:F1`: same id, no link between the two findings. |
| Candidate moves between review and confirmation | confirmation naming the pre-repair candidate, and one naming the moved tree: `stale_candidate` | after the tree is restored, confirmation on the repaired candidate is accepted | Chain `original FAIL, repair, confirmation PASS`. A refused confirmation leaves no record. |

## S9 - cross-run recovery (baseline)

| Case | Today |
|---|---|
| Base branch moves mid-run, over a file a node owns | `base-drift.mjs` reports `OVERLAP` (exit 1) for `src/b.txt`. The engine does not end the run: the next `drive` finishes node `b` (`done`) with no judgment, over the moved base. The pre-flight report is the only signal. |
| Base branch moves after RED was accepted | Single RED node, no dependent: no check ran. The RED evidence stays accepted (`red_invalidated` false) after a `drive` and `ship-ready`. The engine does invalidate RED on a moved base (`redValid`/`refreshRed`) when a dependent of the RED node is checked or dispatched; this world has none. |
| RED provenance and `archive` | The RED attempt output lives under `<ticket>.attempts`; `archive` copies `engine.jsonl`, `manifest.json` and `state.json` only. A second run cannot `init` over the live state (`state_exists`), so it would rely on the archive, which lacks the attempt output. The wording added in N3 (copy it before `archive`) is the mitigation. |

The gap analysis saw archived runs end after a base move. This setup (a named branch as
`config.base`) does not reproduce that stop, so the archived stops are not explained by this
scenario; a `config.base` that defaults to `HEAD` was not run. The scenario pins what was observed.

## Limits

- Fake provider and synthetic repositories only: mechanism, not model quality or real tokens.
- S9 does not show a deleted worktree: it shows that the archive lacks the attempt output, not that a later run failed for lack of it.
- The base move is a branch the plan names as `config.base` (`target`), moved by a commit; other base forms were not run.
- Refusal reasons are normalised (digests and temp paths replaced) so the file is deterministic apart from `wall_ms`.
- The Windows skip (known quiescence limit N7) applies to S8 and S9 as to S1 to S7.

## Byte deviation

The no-unit total is 208,632 (measured with `node skills/ship-ticket/scripts/load-record.mjs --json` on the final candidate; `scenarios.json` was regenerated on the same tree), +1,136 over Wave 2's 207,496. The Wave 2 committed target of 220,000 holds; `execution-harness.md` is unchanged at 40,914. Phase sizes: BUILD 44,933, REVIEW 22,976 (22,526 at Wave 2), SHIP 8,435 (8,048 at Wave 2).

## Deferred: N5 (`db-lock`)

The first review execution failed on `db-lock.mjs` defects (a detached command escaping the engine's quiescence check, an ambiguous `<run>-<db>` label, the lock released while the command's group still ran). The owner chose to cut N5 from this PR; it returns as a follow-up with a simpler design (no detached process group), so this wave ships N1 to N4, N6 and N7.
