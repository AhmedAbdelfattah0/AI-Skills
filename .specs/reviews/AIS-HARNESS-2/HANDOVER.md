# AIS-HARNESS-2 handover: owner-authorized retry `ais2-review-2`

**Start here in a fresh session (`/model sonnet` for the orchestrator).** Opus is used only for the repair builder and the primary review subagent.

## State
- **Branch:** `fix/ship-ticket-wave-plan-mode` (PR #38). Commit `938eca4` holds the implementation; later local commits hold the review records. **Not pushed.**
- **Approved plan (the contract):** `.specs/plans/AIS-HARNESS-2.md`. Its RUN-STATE has START, RED, the two PROVE repairs (both used up) and REVIEW `ais2-review-1` = FAIL (overflow).
- **Reviews:** `review-1-opus.md` and `review-1-codex.md` in this folder.
- **Owner decision (2026-11-05):** authorized ONE retry: review execution `ais2-review-2`, with one REPAIR batch and one targeted confirmation (Opus primary + Codex second opinion). It does not authorize changing scope, PLAN or review policy.

## The REPAIR batch: 17 reconciled findings (fix all, RED first)
The tests for each item must exercise the **real CLI path** (`run-engine.mjs` subcommands on a temp repo), not hand-edited state.

1. **Gate commands** re-verify run identity plus the approved-plan and DAG digests before every mutation (Codex AIS2-01).
2. **Quiescence before `done`:** kill and wait for the whole process group to be gone after the launcher exits. Unknown quiescence (Windows) → judgment point (AIS2-02, Opus F5).
3. **Lock barrier:** `drive` keeps the lock until every launched attempt has settled (`Promise.allSettled`), then rethrows (AIS2-03, F8).
4. **RED runner recovery:** `status:'running'` RED attempts are reconciled like workers, and admission honours durable `S.locks` (AIS2-04).
5. **RED binding:**
   - command, format and resources come from the bound DAG (`config.testCommands` / the node); input only selects;
   - RED evidence is invalidated when a spec digest or the baseline changes;
   - add discriminating tests for the dispatch barrier;
   - repairs are subject to the barrier too (AIS2-05, F2, F9).
6. **Review freeze:** a new original review after a FAIL, or after the freeze, needs an explicit retry authorization record linked to its predecessor. A fresh execution id alone is refused (AIS2-06).
7. **Builder roster:** persist `{provider, model, node}` builder identities from real dispatches, and refuse any reviewer equal to a builder. The two reviewers must also differ from each other (AIS2-07, F1, overflow).
8. **Review contract:** validate nested schemas and outcome enums; empty coverage, criteria or rules are refused (AIS2-08).
9. **Repair → confirmation via CLI:** an accepted FAIL enqueues the finding-bound REPAIR from `v.repair`; completion appends `{kind:'repair', review_execution, old/new candidate}`; then confirmation; then ship-ready. Add an end-to-end CLI test (AIS2-09, F3). Round counters increase only on an actual dispatch (overflow item).
10. **ship-ready** also requires:
    - every required node `done`;
    - no live attempts, pending repairs or unresolved judgments;
    - local proof produced by the engine running the DAG's bound proof commands, not self-attested (AIS2-10, overflow).
11. **Budgets:**
    - load the deduplicated usage sources, including imported orchestrator/reviewer files, before every dispatch;
    - pass the phase, so `phase_tokens` are enforced;
    - repairs go through budget admission;
    - `status` shows the warning and `budget_unenforceable` flags;
    - engine usage records carry `role` and a documented `source` (AIS2-11, F10).
12. **Telemetry never blocks:** sink failures (run-log / RUN-STATE delivery) are recorded as telemetry degradation, with state still replayable. Carrier REPAIR uses engine authorization whenever engine state exists (AIS2-12).
13. **Digest format:** accept `sha256:` (the skill's canonical form, as in the real START) and normalize `sha256-`. Fix the test that pins the dash form (F4).
14. **Plan file in snapshots:** worker snapshots include the ticket plan file, and only a verified RUN-STATE append is allowed (reuse `carrier.mjs runStateAppendOnly`). A null snapshot means `ownership_unavailable`, a judgment point (F6).
15. **Lock:** a live holder with an unknown start time → `lock_held`, never broken (F7).
16. **Exclusions:** enforce the exact pinned list at `validateEngineDag`/`init` (F11).
17. **CI:** add `engine-bench.test.mjs` to the matrix (F12).

**Also fix:**
- the catch-alls in `fits` (`run-engine.mjs:290`) and `record` (`:144`);
- use the clamped `timeoutMs`;
- `mark failed->pending` must record authorization when it clears `quiescence_unknown`;
- the docs/code mismatch on `dispatched_before_red`;
- remove the duplicated launcher (the engine should reuse the carrier's), and bring module sizes back toward ~450 LOC where that is mechanical.

## Then
1. Full suite twice and `cli.mjs validate`.
2. Record REPAIR.
3. Squash into one commit.
4. Compute the candidate with `--exclude .specs/plans/AIS-HARNESS-2.md` (exact path) and record CONFIRM after the targeted confirmation:
   - Opus primary on the repaired closure;
   - Codex second opinion (CodeRabbit fallback).
5. SHIP: push PR #38 with the PR body:
   - implementation summary;
   - architecture decisions;
   - test evidence;
   - the measured bench (6-node fixture: manual 30 commands / 10,272 bytes / 13.6 s sequential, vs engine 3 / 739 / 1.2 s parallel);
   - known limits (worktree isolation deferred; real-ticket savings not yet measured).
6. **Do not merge.**
