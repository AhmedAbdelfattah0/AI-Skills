---
ticket: AIS-BENCH-1 Wave 2b (GitHub issue #60; tracking issue #51)
branch: feat/AIS-BENCH-1-wave-2b-gaps
run_id: w2b-20261111-120141
timing_telemetry: active
native_plan_mode: active
plan_mode_carrier: claude
host_agent: claude
counterpart_agent: codex (CodeRabbit fallback)
plan_debate: {status: SKIPPED, reason: "debate runs only for money or auth tickets (owner rule)"}
worker_width: 3
approval_status: approved
approved_via: ExitPlanMode on 2026-11-11
ui_required: false
review_profile: ELEVATED
review_profile_reasons: ["public skill contract"]
review_timeouts: {primary: 12m, optional: 10m, confirmation: 6m}
base: main@69e2131
execution: manual flow with Agent dispatch (engine helpers not used, declared degradation as in Waves 0-2)
candidate_exclusions: [".claude", ".specs/reviews/AIS-BENCH-1/evidence", ".specs/plans/AIS-BENCH-1-wave-2b.md", "session-log.md"]
---


Branch `feat/AIS-BENCH-1-wave-2b-gaps` from `main` @ `69e2131` · plan file `.specs/plans/AIS-BENCH-1-wave-2b.md` · tracker: new sub-issue under #51 (milestone AIS-BENCH-1) plus a comment on #49 · fresh session on Sonnet via `/ship-ticket`.

**Shape:** harness tooling, references, tests (no FE/BE) · security-sensitive: no · review: ELEVATED (public skill contract) · cross-model plan debate: SKIPPED (not money/auth).

## 1. Context

The gap analysis of five archived runs from a private project (posted on #51, #55, #49) found nine gaps. Seven can be mitigated **without touching an engine module**, so they stay outside the feature freeze (same reasoning as D6, already answered). Owner approved "go Wave 2b" on 2026-11-11. This wave does not lift D2, does not weaken any gate, and adds no `RETRY` cap.

## 2. Scope (what is in / out)

| ID | Item | New/changed files | Gap |
|---|---|---|---|
| N1 | `ship-ready-check.mjs`: every RUN-STATE `SHIP_READY` must match a `GATE ship-ready ok` engine-log line with the same candidate id; run before the commit | `scripts/ship-ready-check.mjs`, `.test.mjs` | G2 |
| N2 | `base-drift.mjs`: compare pinned base with target tip; list changed files overlapping the Design Contract or a node's reads/writes; run at BUILD start, before freeze, before SHIP. Wording: pin `config.base` to a SHA at `init` | `scripts/base-drift.mjs`, `.test.mjs`, wording in `execution-harness.md` | G3, G8 |
| N3 | Wording + pinning tests: `review.md` rule for "primary PASS + second-opinion `fix`" (today `outcome_inconsistent`, `gate.mjs:449-451`); finding ids `<source>:<id>`; `usage.mjs import` after every review; copy RED attempt output before `archive`; owner-exception procedure naming the manual path | `references/review.md`, `ship.md`, `execution-harness.md`, one test pinning the refusal | G1, G4, G5, G8 |
| N4 | `eval.mjs` metrics: RETRY count, gate calls, proof reruns, review usage share; missing review usage = "unknown", never 0 | `scripts/eval.mjs`, `eval.test.mjs` | G5 |
| N5 | **DEFERRED (cut after review execution 1 FAILED on db-lock defects; owner chose "Cut N5, retry", 2026-11-11; follow-up issue)** DB lock wrapper for `testCommands` needing a database (host lock + container label + cleanup) | `scripts/db-lock.mjs`, `.test.mjs` (reuse `docker-lifecycle.mjs` label ownership) | G6 |
| N6 | #49: replace fixed waits with file/event handshakes in the listed tests; CI harness job gets `--test-concurrency=1` if measurement shows it is needed | the failing test files in #49 (`carrier-usage`, `run-engine`, `run-engine-rebind`, `run-engine-review3`, `run-engine-repair`, `run-engine-unit-review`), `.github/workflows/validate.yml` | G9 |
| N7 | Bench scenarios S8 (evidence integrity: primary PASS + minor `fix`; PASS with FAIL second opinion all `not applicable`; reused finding ids; candidate moving between review and confirmation) and S9 (cross-run recovery: base move mid-run, RED provenance in a later run). Today's behaviour is the baseline; results recorded, no behaviour changed | `scripts/engine-bench-scenarios.mjs` (SCENARIOS list), `engine-bench.test.mjs` pinned table, `.specs/reviews/AIS-BENCH-1/wave-2b/` results + README | G1, G3, G4 |

Docs: `AGENTS.md` script list, `validate.yml` test list (R17 requires every new test file), `SKILL.md` links if a new reference is added (none planned; wording goes into existing references to avoid load growth — Wave 2 byte targets must not regress: card ≤ 40,914, total ≤ 207,496 without units).

**Out of scope:** any engine module (`run-engine.mjs`, `engine-*.mjs`, `gate.mjs`, `usage.mjs` behaviour), W3-record/exception/rebase/red/guards, RETRY cap, D2/D3/D5.

## 3. DAG and ownership

| ID | Owner | Depends on |
|---|---|---|
| a: N1 + N2 scripts and tests | builder A (sonnet) | — |
| b: N4 + N5 scripts and tests | builder B (sonnet) | — |
| c: N6 test handshakes (+ CI line) | builder C (opus: concurrency/timing tests) | — |
| d: N3 wording + pinning test | builder A after a | a |
| e: N7 scenarios + results | builder B after b | a, b |
| join: AGENTS.md, validate.yml, validator, link check, byte re-measure (`load-record.mjs`), suites one at a time | orchestrator | all |

Max 3 agents at once. Writers get ownership packets via `scripts/brief.mjs build`. Disjoint files; `validate.yml` and `AGENTS.md` touched only by the orchestrator.

## 4. Risks

| Risk | Handling |
|---|---|
| Wording growth breaks Wave 2 byte targets | measure with `load-record.mjs`; no phase above current; put detail in `harness-internals.md` (on demand) |
| New scripts read clock (`gate-security.test.mjs:135` scans for `new Date().toISOString()`) | inject time via argument |
| #49 fix masks real race | handshake on observable event (file/pid), no longer sleep; verify with 4 concurrent suite copies |
| S8/S9 touch engine paths | scenarios call the real CLI through the existing bench fake provider; no engine edit; baseline rows only |
| Engine suites flake under load | run one at a time, alone on the machine |
| Private data | fixtures synthetic; no private project names, paths or PR numbers in any file |

Security assessment: no changed surface selects a catalog control (`security-plan.mjs select` output goes into the persisted plan).

## 5. Verification

- `node scripts/cli.mjs validate` exits 0.
- New tests: `ship-ready-check`, `base-drift`, `eval`, `db-lock`, `engine-bench` (S8/S9), each with a planted-failure case (hand-written `SHIP_READY` fails; overlapping file reported; killed wrapper leaves no lock).
- #49 AC: four concurrent copies of the harness suite → 0 failures (reference machine); then every suite alone, one at a time (harness, seeded, mutation, security-mutation).
- `load-record.mjs --json`: card/total/phases not above Wave 2 results.
- Bench: S1–S7 unchanged vs `wave-2/scenarios.json` except `wall_ms`; S8/S9 recorded as baseline.
- Grep proves the replaced phrases are gone; `docs-accuracy` pass on changed references.
- Review: Opus primary + Codex second opinion (CodeRabbit fallback), one repair batch max; CI green on all checks; PR closes the new sub-issue; comments on #51, #49, #55 (tick N1–N7); user merges.

## 6. Run order after approval

Create sub-issue and branch; persist plan with START; Design Contract; builders a/b/c; d/e; join + results; PROVE; REVIEW; one commit (staged paths listed, `.claude/` and `evidence/` never added, private-string check), push, PR; CI; tracker comments. Hand over through this plan file, not conversation history.

## Review outcome (recorded at SHIP)

- Execution 1: Opus FAIL (13 findings) and Codex BLOCK (6); one repair batch; confirmation FAIL on db-lock defects (the command escaped the engine's quiescence check). Owner chose "Cut N5, retry" (2026-11-11).
- Execution 2 (N5 cut): Opus FAIL (1 major, 5 minor) and Codex 3 P2; one repair batch; confirmation: Opus PASS, Codex requests one change: `review_usage_share_pct` is still numeric when a builder record lacks counters, and the fix depends on an optional `records` argument. Disposition by the plan's ship threshold (report-only metric, no integrity, security or money effect): ships, tracked in #61.
- Also deferred to #61: N5 redesign, wording points, S9 with a `HEAD`-defaulted base.
- Proof on the final tree: serial suites all green (harness 626/626, properties 2/2, security mutation 1/1); four concurrent harness copies gave 0 failures before the N5 cut and the last repair (not rerun after them).
