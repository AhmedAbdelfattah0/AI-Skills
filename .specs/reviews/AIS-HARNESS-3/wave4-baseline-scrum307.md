# Wave 4 baseline arm: SCRUM-307 (StoreCraft, API keys)

Status: final for the run, n=1, baseline arm only (current harness, no unit review). No claim about unit review versus baseline can be drawn from this file.

**Not a clean engine-gated run.** The engine governed only the first part. After the first review FAIL it stopped on `post_freeze_drift`; the FAIL repair was dispatched by hand through the carrier, and the REPAIR, CONFIRM, FAIL, RETRY and SHIP_READY events in RUN-STATE were written by hand, never produced or validated by the engine gates. The retry's review, repair and confirmation were never recorded in engine state. Treat the review and ship-ready outcomes below as manual-process results.

Source: figures pasted by the owner from the StoreCraft session. Not independently re-measured. Snapshot taken 10:50Z on 2026-11-09, before merge and deploy; the owner states those figures stand.

## Outcome
- PR #356 merged as 29ab73b3; staging deployed and smoke-tested; Jira Done. Feature deployed switched off (`API_KEYS_ENABLED` omitted).
- CI: local replay of 12 gates. First push failed one gate (nn-guard), fixed in a second commit, then all 12 passed. GitHub Actions was billing-blocked.
- Not run: live `wrangler dev` attack replay and browser/RTL screenshot check (local Supabase stack in use by other work). Covered instead by the committed vapt spec and real-Postgres scenarios.

## Measurements (snapshot)
| Item | Value |
|---|---|
| Total tokens | about 183M (orchestrator 93.4M, builders 51.8M, fix/repair 12.0M, Opus relays 16.6M, subagents 9.1M) |
| Codex | about 4.1M for its one successful call, then usage limit; CodeRabbit became the second opinion |
| List-price estimate | about $78, workers and relays only (not an actual charge) |
| Time to ship-ready | 3 h 42 min; phases 5.5 / 31 / ~58 / 58 / 36 min |
| Total wall clock | about 5 h including about 30 min of merge and deploy waiting |
| Review | 2 executions, 1 terminal FAIL, 1 owner RETRY, then a confirmation PASS |
| Findings | execution 1: 1 major, 7 minor; execution 2: 0 backend, 3 frontend minor |
| Peak | 981 MB RSS, 297% CPU |

## Gaps and caveats
- n=1, one arm. Escaped defects (14 days) not yet observable.
- Orchestrator share (about 51%) counts only imported sources; sampler does not cover RED/proof runners.
- Timing logs split between main repo and worktree.
- Two engine stops. (1) After drive 2: `node_failed` on N8, `dispatch refused: workers may not own the plan artifact roots (.specs/.spec)`; resolved by two `mark`s (failed->pending, pending->cancelled). (2) After the first review FAIL, drive 3 (exit 2): five `post_freeze_drift` judgments (N1, RED, N2, N5, N7) with the repair still pending and nothing dispatched.
- The drift was real, not an engine fault. For N1, RED, N2 and N7 it follows from hand edits made after the node completed (run.sh mode and gitleaks markers in fixtures, a typecheck fix in a spec, markers in a token file and two specs). N5 is unconfirmed (guess: a later node rewrote a file both own). The engine offers no supported way to accept such edits: the repair was blocked behind the drift, and the only paths were revert or bypass. The bypass was taken.
- Lost data: the state file, `.engine.jsonl`, `.attempts/`, `.usage.jsonl` and the second half of the timing log were deleted with the worktree (`git worktree remove --force`). Surviving: drive1-3 status outputs, the DAG, the first half of the timing log, and the RUN-STATE block. The token and cost figures cannot be re-derived from engine data.
- Wall clock includes waiting on gate replays, so it is not a measure of compute.

## Next (not started; feature freeze holds)
Matched unit-arm run on the next pool ticket (195, 192, 156, 158, 75), the 3-unit bench fixture, and predeclared net-value measures. Owner decides.
