# Wave 3: failure-scenario coverage (plan "Failure-scenario validation")

Each of the plan's 10 failure scenarios mapped to existing tests in `skills/ship-ticket/scripts/` (file:line of the test title, at the Wave 3 commit). Threat model: accidental/buggy workers only. No engine code was added for this list.

| # | Scenario | Covering test(s) | Status |
|---|---|---|---|
| 1 | Worker crash (incl. mid-check) | run-engine.test.mjs:439 (crash before release), :455 (live worker after engine crash not duplicated); run-engine-units.test.mjs:344 (engine killed mid-check) | covered |
| 2 | Crash during check/integration then `resume` (`quiescence_unknown`) | run-engine-units.test.mjs:344 (unknown-quiescence check runner, resume clears, drive re-checks); run-engine-unit-review.test.mjs:464 (crash between re-check and binding) | covered for checks; see gap A for an integration node |
| 3 | Stale unit evidence after input change | run-engine-units.test.mjs:243; run-engine-unit-review.test.mjs:187 (old evidence id refused); run-engine-wave3.test.mjs (stale `units_consumed` refused) | covered |
| 4 | Shared-contract change re-runs only dependents | run-engine-units.test.mjs:243; run-engine-unit-review.test.mjs:187 (unrelated unit keeps its review) | covered |
| 5 | Concurrent edits to shared files (`conflicts()` + `ownership_violation`, unit-level case) | run-engine-units.test.mjs:390 (units with overlapping writes never scheduled together), :373 (ownership_violation stales only that unit) | covered |
| 6 | Integration failure (node fails, retry <= 1) | run-engine.test.mjs:254 (failed->pending capped at one retry); run-engine-units.test.mjs:191 (failing check blocks dependents, one mark re-runs one node), :431 (failed unit-less dependency leaves the dependent unit unverified) | partial: see gap A |
| 7 | Dependency invalidation with check evidence | run-engine-units.test.mjs:243, :431; run-engine-unit-review.test.mjs:369 (dependent never absorbs an upstream repair) | covered |
| 8 | Repeated repair loop (check fails twice -> judgment, ceiling holds) | run-engine-units.test.mjs:472, :497 (parent_ceiling, no fresh allowance per node or unit), :298 (invalidation storm); run-engine-unit-review.test.mjs:275, :310 (unit review ceiling) | covered |
| 9 | Resource exhaustion (budget_stop / admission; peaks recorded; reservation deferred) | run-engine-repair.test.mjs:433 (imported usage counted before every dispatch, budget_stop), :451 (phase_tokens enforced per dispatching node phase, budget_stop), :461 (repairs go through budget admission); run-engine-units.test.mjs:624 (budget_stop on imported usage); run-engine.test.mjs:690 (admission refusals reach eval); wave1-metrics.test.mjs:21 (peak RSS over attempts) | covered; memory reservation is deferred by the plan, so untested by design |
| 10 | Resume after 3 of 5 units done | run-engine-units.test.mjs:320 | covered |

## Honest gaps (not filled in Wave 3)

- **A. Integration node across units.** No test has a unit-less integration node that depends on two units, fails, gets its one retry and then fails again (or a runner of unknown quiescence during it). The pieces are tested separately (retry cap on a plain node, failed unit-less dependency, mid-check crash), not this combination.
- **B. Bench 3-unit fixture.** The plan asks for the 6-node bench fixture to be extended to a 3-unit fixture for both arms. `engine-bench.mjs` / `engine-bench.test.mjs` still build only the 6-node, unit-less fixture (two waves and one join). Needed before the Wave 4 A/B comparison.
- **C. Over-review cost.** No test measures how many dependent re-checks and re-reviews an upstream re-check triggers when the shared contract bytes are unchanged (the known finer-binding gap from Wave 2b-ii). Documented in plan.md and execution-harness.md as a cost for Wave 4 to measure.
