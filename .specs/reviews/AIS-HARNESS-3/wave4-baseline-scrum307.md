# Wave 4 baseline arm: SCRUM-307 (StoreCraft, API keys)

Status: final for the run, n=1, baseline arm only (current harness, no unit review). No claim about unit review versus baseline can be drawn from this file.

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
- Engine hit the `post_freeze_drift` limit after the final-review FAIL repair; the rest ran manually through the carrier and the harness was marked degraded. This is the known open limit now seen on a real ticket.
- Wall clock includes waiting on gate replays, so it is not a measure of compute.

## Next (not started; feature freeze holds)
Matched unit-arm run on the next pool ticket (195, 192, 156, 158, 75), the 3-unit bench fixture, and predeclared net-value measures. Owner decides.
