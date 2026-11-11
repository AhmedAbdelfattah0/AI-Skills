---
ticket: AIS-BENCH-1 Wave 2c (GitHub issue #61; tracking issue #51)
branch: feat/AIS-BENCH-1-wave-2c-followups
run_id: w2c-20261111-152346
timing_telemetry: active
native_plan_mode: active
host_agent: claude
counterpart_agent: codex (CodeRabbit fallback)
plan_debate: {status: SKIPPED, reason: "debate runs only for money or auth tickets (owner rule)"}
worker_width: 2
approval_status: approved
approved_via: ExitPlanMode on 2026-11-11
review_profile: ELEVATED
review_profile_reasons: ["public skill contract"]
base: main@3718ffb
execution: manual flow with Agent dispatch (engine helpers not used, declared degradation as in Waves 0-2b)
candidate_exclusions: [".claude", ".specs/reviews/AIS-BENCH-1/evidence", "session-log.md"]
---


Branch `feat/AIS-BENCH-1-wave-2c-followups` from `main` @ `3718ffb` · plan file `.specs/plans/AIS-BENCH-1-wave-2c.md` · tracker: #61 (follow-ups from #60/#62), tracker #51 · fresh session on Sonnet via `/ship-ticket`.

**Shape:** harness tooling, references, tests, one results document (no FE/BE) · security-sensitive: no · review: ELEVATED (public skill contract) · plan debate: SKIPPED (not money/auth).

## 1. Context

Owner (2026-11-11): "ship the Wave 2 follow-ups and the gap-analysis items first". Wave 2b (#62) merged with N5 cut and a few deferred items in #61. This run ships everything that needs **no engine module change**, then writes the closure document for the gap analysis. G1 to G4 engine work (review record fields, rebase, exception verb, RED provenance) stays in Wave 3 behind D2; this wave does not lift the freeze, weaken a gate, or add a RETRY cap.

## 2. Scope

| ID | Item | Files |
|---|---|---|
| F1 | **DEFERRED again (cut after review execution 1: exclusivity cannot be guaranteed with Node alone; owner chose "Cut db-lock again, retry", 2026-11-11; see #61).** N5 db-lock redesign. Host lock `db:<name>` for database-backed `testCommands`. Changes from the failed design: **no `detached`** (the command stays in the launcher's process group, so the engine's group-wide kill and quiescence check still cover it); lock records wrapper pid and command pid and is held while either lives; released only when the direct command closes and, on a wrapper SIGKILL, the next wrapper waits while the recorded command pid lives (documented residual: SIGKILL in the gap between spawn and recording); db name restricted to `[A-Za-z0-9]+` and label `<run>.<db>` split at the last `.`, so labels are unambiguous; cleanup scoped to that label; empty/unparseable lock stale by mtime vs a probe file (no clock read), wait loop yields and honours `--timeout-ms`. Prove with the engine's own `gateRunner`: a hung db-locked test command is killed with the launcher group and quiescence sees no survivor. Wording (one sentence, on demand) in `harness-internals.md`. | `scripts/db-lock.mjs`, `.test.mjs` (start from the saved first design, copies in session scratchpad `n5-deferred/` and the failing-review notes in #61), `references/harness-internals.md`, `AGENTS.md`, `validate.yml` |
| F2 | **Review usage share.** `attachUsage` (`run-summary.mjs:232`) already sets `anyUnknown` for the orchestrator share; add `reviewer_share_pct` the same way (unknown when any record of the run lacks counters, builder or reviewer). `eval.mjs` reads it; remove the optional `records` workaround. Test: builder record without counters gives `unknown`; direct `evaluateRun(attachUsage(...))` works. | `scripts/run-summary.mjs`, `eval.mjs`, tests; check `run-engine-units.test.mjs:644` and any golden file stay green |
| F3 | **Wording.** `harness-internals.md` base-pin/SHIP_READY paragraph mentions `run_id` and `--run-id`; `eval.mjs:21-23` doc comment names the counterless case. | `references/harness-internals.md`, `eval.mjs` |
| F4 | **base-drift exit codes.** Split overlap (1) from git or input failure (3); `brief.md` says which stops and which asks the user. | `scripts/base-drift.mjs`, test, `references/brief.md` |
| F5 | **S9 with a HEAD-default base.** Add a row/scenario where `config.base` defaults to `HEAD` and the target moves; record whether the run ends (this is the archived stop). Baseline only, no behaviour change. | `engine-bench-scenarios.mjs`, `engine-bench.test.mjs`, `.specs/reviews/AIS-BENCH-1/wave-2c/` |
| F6 | **Gap-analysis closure document.** One table G1 to G9: final status (closed / mitigated / deferred behind D2), the shipped item, the issue or PR, evidence. G5, G6, G8, G9 closed or mitigated by Waves 2b/2c; G1 to G4 and G7 deferred to W3-record/-exception/-rebase/-red (need D2). Includes the unit-review test confirmation (`run-engine-unit-review.test.mjs`: loaded-run result). | `.specs/reviews/AIS-BENCH-1/gap-analysis-closure.md` (no private names or numbers) |

**Out of scope:** any engine module, gate behaviour, RETRY cap, W3-*, P1 to P4 candidates, D2/D3/D5, byte growth beyond the 220,000-byte target (wording goes in on-demand `harness-internals.md`; the card stays 40,914).

## 3. DAG and ownership

| Step | Owner | Depends on |
|---|---|---|
| a: F1 db-lock + test | builder A (opus: process-group/lock logic) | — |
| b: F2 + F3 + F4 | builder B (sonnet) | — |
| c: F5 | builder B after b (engine-bench files) | b |
| d: F6 closure document | orchestrator | all |
| join: AGENTS.md, validate.yml, load re-measure, validator, suites one at a time, four-copy harness check on the FINAL tree | orchestrator | all |

Max 2 agents at once. `validate.yml` and `AGENTS.md` only by the orchestrator. Builders never run git index commands.

## 4. Risks

| Risk | Handling |
|---|---|
| db-lock repeats execution-1 defects | no `detached`; test through `gateRunner` (engine quiescence), planted-failure tests for each residual; Codex check on the design before confirmation |
| `attachUsage` output pinned by golden/tests | run the engine unit test suite alone before and after; add field only |
| S9 HEAD-default scenario changes S1-S8 results | compare all other scenarios to `wave-2b/scenarios.json` except `wall_ms`/`reference_bytes` |
| Windows CI (CRLF, no process groups) | normalise CRLF in any test that reads markdown; skip POSIX-only db-lock tests on win32 |
| Closure document overclaims | each row cites the merged PR or the deferred item and its blocker; reviewer checks every row against the issues |
| Private data | synthetic fixtures; closure document names no private project, ticket key or PR number |

Security assessment: no changed surface selects a catalog control (`security-plan.mjs select` output goes into the persisted plan).

## 5. Verification

- `node scripts/cli.mjs validate` exits 0; `load-record.mjs --json`: card 40,914, no-unit total at most 208,632 + 300 and well under 220,000.
- New/changed tests each run alone, with a planted-failure case; `gateRunner` db-lock test shows kill and quiescence of the locked command.
- All suites one at a time (harness, properties, security mutation); then four concurrent harness copies on the final tree: 0 failures.
- Bench: S1 to S9 unchanged vs `wave-2b/scenarios.json` except `wall_ms`/`reference_bytes`; the new S9 row recorded.
- Review: Opus primary plus Codex second opinion (CodeRabbit fallback); ship threshold as in the plan: report-only residuals of medium or lower ship with a follow-up; anything touching locks, gates, data integrity blocks. One repair batch, one confirmation. PR closes #61; comments on #51; the user merges.

## 6. Run order after approval

Create branch, persist plan with START, builders a and b in parallel, c, closure document, join and proof, review, one commit (explicit paths, private-string scan), push, PR, CI, tracker comments.

## Review outcome (recorded at SHIP)

- Execution 1: Opus FAIL (1 major: closure document missing the unit-review confirmation; minor lock races and test timing) and Codex REQUEST CHANGES (stalled creator, stale-guard takeover race, unrecorded child pid); one repair batch of db-lock; confirmation: Opus FAIL (closure G9 text stale; a takeover test depended on inode reuse), Codex: takeover race still open (Node has no flock). Owner chose "Cut db-lock again, retry".
- Execution 2 (F1 cut): Opus PASS (1 minor: the G8 row omits the undocumented `HEAD` default of `config.base` and the missing candidate in `status`); Codex ship with follow-ups (S10 `ok` predicate does not assert the post-move baseline; wave-2c README misdescribes how S9 moves `target`). All three ship as follow-ups under the plan's threshold (report and documentation only); recorded in #61.
- Proof on the final tree: serial suites green (harness 629/629, properties 2/2, security mutation 1/1); four concurrent harness copies: 3 of 4 with 0 failures, 1 with one failure (`engine-crash` unit repair drive, the known #49 residual).
