---
ticket: AIS-BENCH-1 Wave 2e, #49 finish (GitHub issue #49; tracking issue #51)
branch: fix/AIS-BENCH-1-49-fixture-warmup
run_id: w2e-20261112-112027
host_agent: claude
counterpart_agent: codex (CodeRabbit fallback)
plan_debate: {status: SKIPPED, reason: "debate runs only for money or auth tickets (owner rule)"}
approval_status: approved
approved_via: owner said go on 2026-11-12
review_profile: STANDARD
base: main@bd19470
execution: manual flow with Agent dispatch (engine helpers not used, declared degradation as in earlier waves)
candidate_exclusions: [".claude", ".specs/reviews/AIS-BENCH-1/evidence", "session-log.md"]
---


Branch `fix/AIS-BENCH-1-49-fixture-warmup` from `main` @ `bd19470` · plan file `.specs/plans/AIS-BENCH-1-wave-2e.md` · tracker #49 · Sonnet orchestrator via `/ship-ticket`.

**Shape:** test-only change to the shared harness test fixture · security-sensitive: no · review: STANDARD plus the mandatory Codex second opinion (no public contract, no production module) · plan debate: SKIPPED (not money/auth).

## 1. Context

Daytime four-copy runs of the harness suite fail massively on pristine `main` (56 to 59 failures per copy, measured 2026-11-12) while the same check passes early morning. Cause (measured by an earlier builder, 100 samples): every fixture writes a fresh `bin/claude` shell script (`engine-test-fixture.mjs:112`); under load the first exec of a newly created executable takes median 3.3 s, p90 11.5 s, max 13.6 s (second exec <= 113 ms; quiet machine 317 ms then 28 ms). The engine's production subscription check (`verifySubscription`, `provider-env.mjs:36`) runs `claude auth status --json` with a 15 s limit and, being the first exec, pays that cost; past 15 s it correctly refuses with `billing_unverified`, so bench scenarios S1 to S10 and other tests that drive the real CLI end in `judgment` with node `a` pending. The production budget is not changed.

## 2. Change

In `fixture()` (`engine-test-fixture.mjs`), right after the `claude` wrapper (or `claude.cmd` on Windows) is written and made executable, run it once synchronously as a warm-up: `spawnSync(<bin>/claude, ['auth','status','--json'], { env, stdio: 'ignore' })` with NO timeout. The fake's `auth` path (`FAKE_CLI`) exits 0 immediately, writes no `runs.log` line and touches no state, so behaviour is unchanged; only the one-time exec cost moves into fixture setup, where no production budget applies. Applies to every test using the shared fixture. Windows: warm the `.cmd` the same way (or skip if it cannot be spawned without a shell; do not add a shell where none was used). Also check `engine-bench-scenarios.mjs` `world()` (it calls `fixture`), `engine-explore.test-helper.mjs` and any other place that writes its own fake `claude`; warm those too if they exist.

**Out of scope:** any production module or budget (`verifySubscription`'s 15 s), other tests, W3 items.

## 3. Execution

One Sonnet builder (small mechanical change), then proof by me.

## 4. Risks

| Risk | Handling |
|---|---|
| Warm-up changes what a test observes | it uses the `auth` path only (no runs.log line, no state); run the whole harness serially: must stay 657/657 |
| Fixture setup gets slower in aggregate | one exec per fixture (~30 ms quiet); measure the serial run time before/after |
| Masks the production stall instead of fixing it | by design: the production check legitimately times out on a stalled CLI; the stall is a test-environment artifact. Documented in the fixture comment and in #49 |
| Windows | no shell added; skip or `.cmd` spawn exactly as the engine does |

## 5. Verification

- A positive test that the warm-up ran: the fixture exposes `fx.warmedUp === true` (or the equivalent), asserted in `run-engine-record.test.mjs`-style new small test file or in an existing fixture test; mutation: removing the warm-up call turns it red.
- Whole harness serial: 657/657; validator exits 0.
- **Daytime control comparison** (same method as the control I ran on main): four concurrent copies on this branch while the machine is busy; pristine `main` gave 56 to 59 failures per copy; this branch must give a clear drop (target: 0 to 3, the known #64-class flakes at most). Report both numbers.
- Review: Opus (STANDARD, one reviewer) plus Codex; one repair batch max; PR "Refs #49" (never write the word "close" near a number); the user merges.

## Review outcome (recorded at SHIP)

- Review: Opus FAIL (1 major: engine-bench.mjs left cold; 2 minors) and Codex 2 P2 (a load-fragile timing assertion; engine-explore restore left cold) plus a Windows note; one repair batch added a shared `warmFakeClaude(bin, env)` used by the fixture, the bench sandbox (before timing starts) and the explore helper restore, corrected the Windows spawn and comment, and removed the timing assertion. Codex check of the repair: clean. Opus confirmation: PASS.
- Proof on the final tree: serial 13 of 13 steps green (harness 658/658); four concurrent harness copies: 0 failures in 12 of 12 copies across three rounds (start loads 2.6, 10.7, 3.8; load reached 20.6 in the last), against pristine main 8 to 10 failures per copy (start load 7.3) and 56 to 59 failures per copy in the earlier daytime control.
- Not covered: carrier-usage.test.mjs fakeCli wrappers stay cold (its dispatches stub the subscription check and use a 120 s worker bound); recorded in #49.
