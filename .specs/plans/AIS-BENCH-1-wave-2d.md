---
ticket: AIS-BENCH-1 Wave 2d, #49 residual (GitHub issue #49; tracking issue #51)
branch: fix/AIS-BENCH-1-49-engine-crash
run_id: w2d-20261111-184400
host_agent: claude
counterpart_agent: codex (CodeRabbit fallback)
plan_debate: {status: SKIPPED, reason: "debate runs only for money or auth tickets (owner rule)"}
approval_status: approved
approved_via: ExitPlanMode on 2026-11-11
review_profile: STANDARD
base: main@888df9e
execution: manual flow with Agent dispatch (engine helpers not used, declared degradation as in earlier waves)
candidate_exclusions: [".claude", ".specs/reviews/AIS-BENCH-1/evidence", "session-log.md"]
---


Branch `fix/AIS-BENCH-1-49-engine-crash` from `main` @ `888df9e` · plan file `.specs/plans/AIS-BENCH-1-wave-2d.md` · tracker: #49 (reopened), tracker #51 · Sonnet orchestrator via `/ship-ticket`.

**Shape:** test-only change in harness tests (no FE/BE) · security-sensitive: no · review: STANDARD plus the mandatory Codex second opinion (test files only, no public contract, no engine module) · plan debate: SKIPPED (not money/auth).

## 1. Context

After Wave 2c, four concurrent copies of the harness suite give 0 failures in most copies but the test `exceptions: a crash at every boundary of the unit repair drive` (`skills/ship-ticket/scripts/engine-crash.test.mjs:109-120`, lane at `:66-100`) still fails intermittently under load. It was never in the fixed set (flagged as unowned in Wave 2b). Observed failure: `hit 41 (rename) neither crashed nor was absorbed: temp-write temp-fsync rename ...` (`:86-88`).

**Mechanism (read from the code).** The test runs the engine's unit-repair `drive` once as a reference and records every persistence/launch boundary hit (`hook()`, `:54-56`). It then re-runs the same drive once per hit index k, crashing at the k-th boundary. Under CPU load the crashed run takes a shorter path than the reference (the count of boundary hits is timing-dependent: polling or retry saves differ), so hit k is never reached, the hook never throws, the run completes, and the assertion at `:88` reports "neither crashed nor was absorbed". Exactly which hits vary is not yet known.

## 2. Scope

| ID | Item | Files |
|---|---|---|
| T1 | **Find which boundary hits vary under load.** Run the reference drive several times under 4x load with the hit list logged (name sequence); diff the sequences and name the non-deterministic hits. Read-only findings go into the plan's notes. | scratch only |
| T2 | **Make the crash index robust.** Preferred: key each crash point by the boundary's stable identity (name, node/unit, ordinal of that name within a deterministic phase) instead of a global hit count, so a polling save that appears or disappears does not shift k; if a point is genuinely not reached because the run legitimately took a shorter path, retry that case once on the same snapshot and fail with the full hit trace only if it is still not reached. Never skip a boundary silently; never weaken the recovery oracle (`summary`, `classify`, `shown`). | `skills/ship-ticket/scripts/engine-crash.test.mjs` (and `engine-explore.test-helper.mjs` only if the hook needs an extra identity field; no production module) |
| T3 | **Prove it.** Four concurrent copies of the harness suite, twice, on the final tree: 0 failures; the test still fails when a real recovery bug is planted (mutation: break `resume` accounting in a temp copy). | scratch + results note in `.specs/reviews/AIS-BENCH-1/wave-2d/README.md` |

**Out of scope:** any engine or production module, production budgets, other tests, Wave 3 items, W3-record (next run).

## 3. Execution

One Opus builder (timing/concurrency test repair, `opus`; investigation needs judgment), orchestrator Sonnet. T1 first, then T2, then T3. No parallel writers (single file).

## 4. Risks

| Risk | Handling |
|---|---|
| Fix hides a real recovery bug | keep the oracle unchanged; planted-failure mutation must turn the test red; every boundary of the reference is still crashed exactly once (the existing assertion at `:111` stays) |
| Retry masks a real nondeterminism bug in the engine | retry only the not-reached case once; record how often it fired in `t.diagnostic`; if the engine's hit sequence varies for a reason that is itself a bug, stop and report it for #49 instead of papering over it |
| Machine noise | suites one at a time, nothing else running; four-copy check done twice |

## 5. Verification

- `node --test skills/ship-ticket/scripts/engine-crash.test.mjs` alone: green, several times.
- Planted mutation turns it red.
- Whole harness serial run: green. Four concurrent copies of the harness suite, twice: 0 failures.
- `node scripts/cli.mjs validate` exits 0; no production file in `git diff --stat`.
- Review: one independent reviewer (opus, since concurrency tests) plus Codex second opinion; one repair batch, one confirmation; PR closes #49; the user merges.

## Review outcome (recorded at SHIP)

- Scope extended by the owner during the run: test G in `run-engine-review3.test.mjs` (same cause). S1 and sibling tests that fail only under heavier-than-specified load are left for a fixture warm-up follow-up (first run of a freshly written fake `claude` script can take up to 13.6 s under load).
- Review: Opus PASS (3 minor) and Codex P2 (a first-run timeout discarded by the retry); one repair batch fixed all of them; confirmation: Opus PASS, Codex no findings.
- Proof on the final tree: serial 629/629, properties 2/2, security mutation 1/1; four concurrent harness copies: round A 0 failures in 4 of 4, round B 3 of 4 clean and one copy with one failure in `sampler: a child that allocates memory yields a peak RSS reflecting it` (unrelated, not touched).
