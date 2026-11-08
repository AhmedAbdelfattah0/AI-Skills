OUTCOME: FAIL

# ais2-review-2 — Opus primary, targeted confirmation of the ais2-review-1 REPAIR

- reviewer_identity: claude-opus-5.5, independent primary reviewer, read-only (did not build this)
- candidate_id: 7f586fe06f6d546b9bbf728133aee96534290082cad71792d7a8c26a65c7afea (HEAD d305763, base origin/main, plan file excluded)
- Method: read every finding against the code, and ran `run-engine-repair.test.mjs` (34/34 pass).
- Mutation runs, each one-line, in a scratch copy, with the matching test pattern:
  - **killed:**
    - quiesce→false (R2: 2 fail)
    - verifyBinding call removed from gate (R1 fail)
    - redReady→true (R5: 4 fail)
    - RETRY check disabled (R6 fail)
    - builders.push disabled (R7 fail)
    - rule_rows non-empty check disabled (R8 fail)
    - judgments_unresolved check removed (R10 fail)
    - drain loop breaks on failure with the allSettled finally removed (R3 fail)
  - **survived:**
    - removing only the `finally { Promise.allSettled }` (R3 passes). The drain loop already waits for every attempt. The `finally` only matters for a synchronous throw inside the loop (`fits`/`schedule`, or `budgetOk` reading the import file), and no test covers that. This is a test gap, not a defect.
- Empirical N3 check: a default fixture (no `modelMap`) records the builder as `claude:provider-default`, and `gate review` with primary `claude:claude-opus-5-5` returns `review_accepted` (exit 0).

## The 17 findings

| # | Finding | Closed? | Code evidence | Test discriminates? |
|---|---|---|---|---|
| 1 | Gates re-verify run id + plan + DAG digests (AIS2-01) | closed | `run-engine.mjs:97-106` verifyBinding; called first in gate `:280-281`, drive `:214`, resume `:199`, mark `:249` | yes, R1 (approval/DAG/run drift each refused, nothing recorded) |
| 2 | Whole-group quiescence before `done`; unknown -> judgment (AIS2-02, F5) | closed | `engine-attempts.mjs:201-208` quiesce -> kill+await group, `quiet !== false` -> `quiescence_unknown`; `engine-io.mjs:224-227` | yes, mutation confirmed (both R2 tests fail) |
| 3 | Lock barrier: allSettled before lock release (AIS2-03, F8) | closed | `engine-attempts.mjs:348-365` try/finally `Promise.allSettled`, judgments no longer `break` out with attempts running; `run-engine.mjs:225` commit in finally | yes, R3 (sibling `a` must be `done` before rejects) |
| 4 | RED runner recovery + durable locks in admission (AIS2-04) | closed | `engine-attempts.mjs:226-244` runners in `intent/running` reconciled; `:325` fits honours `S.locks` | yes, R4 (real crashed gate, live runner blocks `w`) |
| 5 | RED bound to DAG; invalidation; barrier tests; repairs under barrier (AIS2-05, F2, F9) | closed (see N2) | `engine-gates.mjs:26-40` runner/format/resources/timeout from DAG; `engine-dag.mjs:156-161` input refuses command objects; `engine-attempts.mjs:80-104` redValid (spec digests + base commit) and repairRedReady | yes, R5 x5 (barrier removal dispatches `p`; repair barrier removal runs `fix`) |
| 6 | Review freeze; retry needs RETRY linked to predecessor (AIS2-06) | closed (see N4) | `engine-gates.mjs:54-67` retry_unauthorized / stale_candidate against stored freeze | yes, R6 (fresh id refused, wrong predecessor refused, linked RETRY accepted) |
| 7 | Builder roster from real dispatches; reviewers != builders and != each other (AIS2-07, F1) | **partial**: closed for mapped models, fail-open for `provider-default` (N3) | `engine-attempts.mjs:279-280`; `gate.mjs:274-307` | yes, R7 |
| 8 | Nested contract + enums; empties refused (AIS2-08) | closed | `gate.mjs:247-268`, second opinion `:299-302` | yes, R8 (6 variants) |
| 9 | FAIL -> REPAIR -> repair record -> confirmation via CLI; counters on real dispatch | closed (see N5) | `engine-gates.mjs:80-84` enqueue; `engine-attempts.mjs:167-181` repair record + re-freeze; `:251-282` onLaunch after prepareDispatch | yes, R9 x3 end-to-end via CLI |
| 10 | ship-ready completeness + engine-run local proof (AIS2-10) | closed | `gate.mjs:399-416`; `engine-gates.mjs:88-131`; `engine-dag.mjs:142-143` input `local_proof` is a usage error | yes, R10 x3 |
| 11 | Budgets: imports, phase, repairs, status flags, role/source (AIS2-11, F10) | closed | `engine-attempts.mjs:43-70`, `:354`, `:396`; `run-engine.mjs:123-129`; usage record `:132-133` | yes, R11 x5 |
| 12 | Telemetry never blocks; carrier REPAIR uses engine state (AIS2-12) | closed | `run-engine.mjs:144-159` degrade + keep in outbox; `carrier.mjs:142-155` engine state first | yes, R12 x2 |
| 13 | Digest `sha256:` canonical, `sha256-` normalized (F4) | closed | `engine-dag.mjs:13-15`; `run-engine.mjs:58`, `:174-175` | yes, R13 |
| 14 | Plan file in worker snapshots; append-only allowed; null snapshot -> ownership_unavailable (F6) | closed (see N6) | `engine-attempts.mjs:112-125` (`runStateAppendOnly`), `:135-138`, `:211-215` | yes, R14 x2 |
| 15 | Live holder with unknown start time -> lock_held (F7) | closed | `engine-io.mjs:126-127` | yes, R15 |
| 16 | Exact exclusions enforced at init (F11) | closed | `engine-dag.mjs:72-76` with `exactExclusions`; `run-engine.mjs:170` passes ticket | yes, R16 (4 bad lists) |
| 17 | engine-bench in CI (F12) | closed | `.github/workflows/validate.yml:54`; R17 checks every test file | yes |

## Also-fix list

| Item | Closed? | Evidence |
|---|---|---|
| catch-all in `fits` | closed | `engine-attempts.mjs:324-336`, no try/catch; schedule errors propagate through the allSettled barrier |
| catch-all in `record` | closed | `engine-attempts.mjs:131` uses `readIfExists` (ENOENT only). `readJson` (`engine-io.mjs:198`) still swallows everything for the envelope; the envelope is written by atomic rename, so acceptable |
| clamped `timeoutMs` | closed | `engine-attempts.mjs:254`, `engine-gates.mjs:35`, `:98`; test X |
| mark failed->pending records cleared judgments | closed | `run-engine.mjs:255-264`; test X |
| `dispatched_before_red` docs/code | closed | `gate.mjs:161-163` returns `judgment_point: true`; matches `execution-harness.md:429-430` |
| duplicated launcher removed | closed | `launcher.mjs` is the one implementation; `engine-io.mjs:214-217` and `carrier.mjs:503` both use `launcherArgs` |
| module sizes ~450 | closed | run-engine 326, engine-attempts 404, engine-io 296, gate 420, carrier 620 (carrier was not in the size finding) |

16 of 17 findings are closed in code; finding 7 is partial (N3). All also-fix items are closed.

**The FAIL rests on N3.** It is an incomplete closure of a review-1 blocker, and it touches review integrity in the default configuration.

N1 and N2 fail closed and touch liveness only. Under the owner's ship threshold they are candidates to ship with a follow-up ticket. N1's fix also needs a PLAN amendment (see below).

## New findings

**N1 — major (fail-closed liveness: ship with a follow-up, or by owner decision) — `run-engine.mjs:251-259` (with `engine-attempts.mjs:137,144,175,206,229`).** The only CLI path that clears a durable judgment is `mark failed->pending`, and it works only on a failed *node* that still has a retry left. The repair makes several durable judgments reachable that it cannot clear:
- judgments keyed to a repair id: `repair_outside_findings`, `ownership_unavailable`, `quiescence_unknown`, `candidate_unavailable`. `S.nodes['repair-rx']` does not exist, so `mark` refuses.
- `quiescence_unknown` from `settleRunner` on a RED node that is `done`, or on a proof runner whose "node" is a testCommands name.
- any node judgment after its one retry was spent, including by an automatic INFRA_RETRY. `retry_cap` refuses.

Consequence: `drive` refuses all dispatch (`run-engine.mjs:220`, `engine-attempts.mjs:350,392`) and ship-ready refuses `judgments_unresolved` forever. The only way out is hand-editing the state file, which the engine's own design forbids. A realistic trigger: the repair worker touches a file that is not in the finding paths.

This fails closed, so it is not a safety defect, but it dead-ends the very path that findings 9 and 10 made reachable.

Fix: add a recorded resolution for these judgments, for example `mark --judgment <code> --node <id> --reason`, which clears the judgment and records `cleared_judgments` without marking anything done. A failed repair must also be able to reach a RETRY.

The legal `mark` transitions are fixed by the approved plan (`.specs/plans/AIS-HARNESS-2.md:82`). This fix is therefore a PLAN amendment, an owner decision, and not an in-scope repair item.

**N2 — major (fail-closed liveness, narrow trigger: ship with a follow-up) — `engine-attempts.mjs:80-104` with `gate.mjs:136`.** RED evidence is invalidated when a spec digest or the resolved `config.base` commit changes. Re-establishing RED requires every spec to fail with an assertion. Once the dependents are built, though, the specs pass, so `gate red` returns `spec_not_failing` and RED can never be re-established.

Repairs and stale re-runs then wait on `red_required` or `red_invalidated` forever.

Precondition: the dead end needs two things.
- First, after RED, either a spec file changes or the resolved `config.base` moves. Examples: a first repair edits a spec, then a RETRY's repair needs the barrier; or there is a commit mid-run, or a fetch with `base` set to a remote ref.
- Second, a repair or a stale node then needs the barrier.

Neither the plan nor `execution-harness.md` sets `base`, so it defaults to `HEAD`, and ship-ticket commits only at SHIP. Exposure during a normal run is therefore narrow.

The behaviour follows handover item 5b as literally implemented.

The R5 repair test passes only because its fixture's spec still fails after the production node "implements" it. That is unrealistic, so the test does not cover the real case.

Fix: apply the invalidation only before the first dependent dispatch. Once dependents were built under valid RED, make a later change a judgment the user can acknowledge, rather than a requirement that can no longer be met. Alternatively, pin `base_commit` to the resolved SHA at init rather than to a moving ref.

**N3 — major (BLOCKS: review integrity; an incomplete closure of finding 7 / F1, not a newly introduced defect) — `engine-attempts.mjs:279-280` with `carrier.mjs:223,255` and `gate.mjs:274`.** With no `modelMap` entry for the routed tier (the DAG default is `modelMap: {}`), `plan.model` is `'provider-default'`. The builder identity is then `claude:provider-default`. `sameIdentity` never matches it against a reviewer such as `claude:claude-opus-5-5`, even though the provider default may be exactly that model.

Independence is unknown here, and the check passes. That is fail-open, and it is the default configuration. R7 only covers a mapped model.

Fix: treat a `provider-default` builder as matching every reviewer of the same provider, so the gate refuses with `reviewer_is_builder` / unknown independence; or refuse the dispatch without a resolved model.

**N4 — minor — `engine-gates.mjs:42-47` with `engine-attempts.mjs:116-118`.** Retry authorization is a RUN-STATE `RETRY` event in the plan file. Workers are allowed verified RUN-STATE appends, so a builder or repair worker can append the `RETRY` that authorizes a new original review. The orchestrator can already write RUN-STATE, so this adds no new privilege for the orchestrator. It does let a dispatched worker forge an authorization record.

Fix: refuse `RETRY`, `START` and `DAG_BOUND` events in a worker's append, by parsing the appended lines.

**N5 — minor — `engine-attempts.mjs:282`, `:152-156`, `:313-320` with `:376`.** `onLaunch` spends the review repair round at intent time. Suppose the launcher fails to spawn, or the provider errors with no writes. The automatic INFRA_RETRY re-queues the repair as `pending`, and the next `authorize` returns `round_limit`. The retry that the infra-retry rule promises never happens for review repairs.

`batchOpen` is per `runRepairs` call, so a PROVE retry in a later `drive` opens a new batch. There is currently no CLI that enqueues PROVE repairs, so that branch is unreachable.

**N6 — minor — `engine-io.mjs:288` and `engine-gates.mjs:101-104`.** RED and proof runners call `quiesce()` but ignore its result. A runner group that survives SIGKILL is still recorded `exited`, and its resource locks are released. On Windows (`pgid` null) neither quiescence nor a judgment applies. Workers got the fix in finding 2; runners did not.

**N7 — minor — Windows (`engine-attempts.mjs:293`, `:201-207`).** Every worker attempt ends in `quiescence_unknown` and `failed`. `mark failed->pending` can be used once per node, and no transition leads to `done`, so no Windows run can complete through the engine. This is consistent with the plan's text (`execution-harness.md:424-425`). It should be stated as a known limit in the PR body, not presented as "a human resolves it".

## Not re-opened (by design or out of scope)

- `pending->cancelled` counts as finished at ship-ready. This is documented in `execution-harness.md:490`.
- Reviewer identity is self-declared text.
- Carrier REPAIR checks only that the FAIL exists, not rounds or write set. A carrier repair cannot produce a confirmable chain, because the freeze and the repair record are engine-only.

## Counts

blocker 0 · major 3 (N3 blocks; N1 and N2 are fail-closed liveness, follow-up eligible) · minor 4 (N4–N7). Plus one test gap: the allSettled `finally` is unexercised.
