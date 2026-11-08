# ais2-review-1 — Opus primary review (FAIL, overflow)

- **reviewer_identity:** claude-opus-5.5, independent primary reviewer, read-only. It did not build this.
- **candidate_id:** 57d8a0879f221b2570a38207488cfe71275dfb781e141ad95ce3ec74e4cc25c1 (diff `origin/main...938eca4`)
- **Tests:** 203/203 pass, `cli.mjs validate` passes, and the bench reports 30→3 orchestrator commands. None of these reach the blockers below.

## Acceptance criteria

| AC | Outcome | Evidence and gaps |
|---|---|---|
| 1 Approval | PASS, with F4 | `run-engine.mjs:54-62`, `:376-377`, `:414-419`; `mark` limited by `:38` and `:444-456`. |
| 2 Lock | PARTIAL | F7 |
| 3 Persistence | PASS | `engine-io.mjs:40-70`; tests at `run-engine.test.mjs:481-543` |
| 4 Crash | PARTIAL | F5. The Windows test injects `groupAlive: null` and is skipped on Windows. |
| 5 Staleness | PASS | |
| 6 Gates | FAIL | F1, F2, F3, F9. The parsers are sound: an import or compile error cannot pass as an assertion. |
| 7 Carrier | PASS | |
| 8 Usage | PARTIAL | F10: the library is fine, but the engine integration does not match the docs. |
| 9 Eval | PASS | |
| 10 No regressions | PARTIAL | F12 |

## Rule rows

| Rule | Outcome | Evidence |
|---|---|---|
| no-catch-all | FAIL | `fits` (`run-engine.mjs:290`) swallows every `schedule` error; `record` (`:144`) swallows a missing stdout file. |
| fail-closed checks | FAIL | F6, F7 |
| tests assert behaviour | PARTIAL | The repair and round-limit tests build their state by hand with `fx.editState`. Two guards survived mutation (F9). |
| size ≤ ~450 per module | FAIL | `run-engine.mjs` is 563 lines and `engine-io.mjs` 448. The launcher is duplicated in `carrier.mjs` and `engine-io.mjs:217`. The engine never calls the carrier's `dispatch()`. |
| PLAN text unchanged | PASS | |
| REVIEW never dispatched | PASS | |
| billing guard | PASS | |

**security_outcome: FAIL.**

## Findings

**F1 — blocker — `run-engine.mjs:489`.** `builders: S.builders ?? []`, and nothing ever writes `S.builders`.
- Consequence: `gate review` never refuses a builder acting as reviewer.
- Fix: record a builder identity (provider:model:node) on every dispatched attempt, and add a CLI test that refuses one.

**F2 — blocker — `run-engine.mjs:479-480`.** `gateRed` takes `command`, `format` and `resources` from the input; `config.testCommands` is never read.
- Consequence: the orchestrator can choose the "runner" that produces the evidence, and can drop the resource locks.
- Fix: take all three from the bound DAG. Input may only select among them.

**F3 — blocker — `run-engine.mjs:490` and `gate.mjs:326-334`.** `v.repair` is dropped. Nothing creates `S.repairs`, and nothing appends `{kind:'repair', new_candidate}` to the chain.
- Consequence: FAIL → REPAIR → confirmation → ship-ready can't complete through the CLI.
- Fix: enqueue the repair, append the repair record, and add an end-to-end CLI test.

**F4 — major — `engine-io.mjs:20` and `run-engine.mjs:60`, `:376`.** The engine computes digests as `sha256-<hex>`, while real START events use `sha256:<hex>`.
- Consequence: `init` refuses real plans; a test pins the dash form.
- Fix: normalize the prefix, or specify one format.

**F5 — major — `run-engine.mjs:189` and `:263-266`.** A successful attempt never checks that its process group is gone.
- Consequence: background descendants outlive a node marked `done`. This regresses the carrier's tree-termination guarantee (CX-5).
- Fix: kill the group and require `groupAlive === false` before recording `done`.

**F6 — major — `run-engine.mjs:76` and `:149`.** The ticket plan file is excluded from worker snapshots, and a null snapshot counts as clean.
- Consequence: a worker can forge RUN-STATE events or edit the narrative without a violation, and a git failure silently skips the ownership check.
- Fix: allow only a verified RUN-STATE append, and treat a null snapshot as `ownership_unavailable` (a judgment point).

**F7 — major — `engine-io.mjs:127`.** A holder whose start time is unknown (because `ps` failed) is treated as PID reuse.
- Consequence: the lock is broken while its holder is alive.
- Fix: alive with an unknown start time → `lock_held`.

**F8 — major — `run-engine.mjs:314` and `:87`.** `Promise.race` over running attempts: if one rejects, `drive` exits and releases the lock while siblings keep committing.
- Fix: `Promise.allSettled` the in-flight attempts, then rethrow.

**F9 — major — `run-engine.mjs:306` and `:160`.** I removed the RED dispatch barrier and forced `quiet = true`; all 40 engine tests still passed. Repairs also skip the RED barrier (`:347-360`).
- Fix: add discriminating drive tests, and apply the barrier to repairs.

**F10 — major — `run-engine.mjs:318-325`.** The budget reads engine attempts only. No phase is passed, imports are never loaded, and the 80% warning and `budget_unenforceable` never reach `status`. Usage records lack `role` and use `source:'engine'`.
- Fix: wire the budget to the documented behaviour.

**F11 — minor — `engine-io.mjs:281` and `run-engine.mjs:380`.** The exclusion list is not enforced at init/validate.
- Consequence: a wrong list only dead-ends at ship-ready.
- Fix: enforce `exactExclusions` at init.

**F12 — minor — `validate.yml:44-52`.** `engine-bench.test.mjs` is not in the CI matrix.

## Overflow (true)

- The second opinion's `reviewer_identity` may equal the primary's (`gate.mjs:283`). This is untested.
- `local_proof` is self-attested (`run-engine.mjs:498`).
- Round counters increase before `runAttempt` (`:356`), so a refused dispatch uses up the only authorized repair.
- `DAG_BOUND` is self-attested by the orchestrator.
- `mark failed->pending` clears `quiescence_unknown` without recording any authorization.
- The engine timer uses the raw `cfg.timeoutMs` (`:262`) rather than the clamped value.
- The docs list `dispatched_before_red` as a judgment point, but the code returns `judgment_point:false`.
- The repair tests depend on hand-edited state.

**outcome: FAIL**
