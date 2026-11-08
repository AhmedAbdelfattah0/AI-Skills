# Wave 3.5 review record (verdict policy: blocking needs scenario + property + consequence + trace)

Commits: 5728463 (build), 2c2e4cc (repair). Threat model: accidental/buggy workers only.

## Round 1 (5728463)
- Opus primary: PASS. Non-blocking N1-N9 (oracle blind to node-level staleness, seeded defaults never reach ship-ready or confirmation, docs overclaim, mutation "caught" = any non-zero exit, CI job without timeout, D5 crash-test race).
- Codex second opinion: FAIL, one blocking finding. A local-proof command that moves the base commit (e.g. `git commit --allow-empty`, base=HEAD) leaves the candidate hash unchanged but makes unit evidence stale; `shipReadyGate` checked unit freshness only before the proof, so SHIP_READY was emitted (P5/P12). Verified in code by the orchestrator; predates Wave 3.5. Non-blocking: the `spendCeiling` "equivalent mutant" claim was unsound (counter-trace), oracle independence gaps, past-finding coverage gaps.

## Repair (2c2e4cc), one batch
Post-proof unit recheck (`unitShipRefusal`, test red-first with a real empty-commit proof); Codex's spendCeiling trace reproduced as a directed test and the equivalence claim removed; oracle node-freshness check plus `drift()` mutant; seeded defaults 1,2,3,4,5,9,20 with positive-signal assertions; mutation "caught" requires the mutant's own property; CI `timeout-minutes: 45`; D5 readiness marker; docs list what the harness does not show.

## Confirmation
- Opus: PASS (no blocking). Ran suite (403 tests, 402 pass, 1 skip) and `cli.mjs validate`; re-proved red-first for the proof test, the spendCeiling room mutant and the drift mutant. Did not run the full mutation suite.
- Codex: PASS (no blocking). Static inspection and in-memory probes only; it could not write the filesystem so it did not run the integration tests.
- Orchestrator ran full suite on 5728463 (401/400/1 skip) and validate; builder ran mutation on 2c2e4cc: 8 of 8 mutants caught on their own property.

## Owner-pending items (documented in PROPERTIES.md, not fixed under the feature freeze)
1. A unit whose evidence goes stale loses its ceiling hold; reverting the input restores "awaiting confirmation" with no hold (confirmation refused `parent_ceiling` if another recheck took the slot, otherwise spends unheld allowance). Options: restore the hold, refuse, or accept as limit.
2. A final-review FAIL repair does not clear `post_freeze_drift`; route is revert (and owner RETRY if drift predates the final review).

## Known limits carried
D1-D7 in PROPERTIES.md; passing exploration shows no violation in the explored states only, not that the engine is safe.
