# AIS-HARNESS-3 Wave 1 review (commit 6f856cf plus one repair commit)

Scope: instrumentation only (launcher peak RSS/CPU sampler, eval resource and cost metrics). No behaviour change.

## Verdicts
- Opus (primary): PASS, conditional on the AC-W1 wording and evidence below.
- Codex (second opinion): FAIL, major. The I15 change made a usage file with a malformed or crash-truncated JSONL line exit 1, which changes an exit contract in an instrumentation-only wave. Fixed by the repair: the skip-malformed behaviour is restored, a test pins that a truncated trailing line is skipped and the report still prints, and I15 is marked deferred (own owner decision) in `wave0-coderabbit-dispositions.md`.

## Repair batch
1. eval.mjs: `readJsonl`/`readUsage` back to skip-malformed (no `strict`).
2. launcher.mjs: sampler `ps` spawned with `LC_ALL=C` (Opus minor: a comma-decimal locale printed `41,1`, parsed NaN, peak always unknown). Test runs the real launcher with `LC_ALL=de_DE.UTF-8` in the parent env; it skips if the locale is absent.
3. observability.md: peaks cover WORKER attempts only; %cpu is a per-process average whose window differs by OS (Linux lifetime, macOS decaying recent).
4. AC-W1 reworded in `.specs/plans/AIS-HARNESS-3.md`: sampler overhead <2% of wall measured with a real durable launcher running a CPU-bound worker; engine-bench measures engine overhead only (engine-bench never spawns the launcher).

## Measured overhead
- Opus, real durable launcher, 5 s CPU-bound worker: sampler on 5061 / 5054 ms vs off 5046 / 5104 ms, about 0.3%, within noise. `ps` costs about 16 ms per sample with 738 processes.
- Builder, engine-bench: -1.3%. Fixture workers run about 100 ms, so at most one sample fires; this is launcher overhead only and is not the AC-W1 evidence.

## Deferred minors
- Runner (RED / proof) peaks are dropped: `engine-io.mjs:277` and `engine-gates.mjs:174` do not go through the launcher. Documented as worker-only.
- `run-summary` `anyUnknown` may rarely let the >50% orchestrator suggestion fire.
- Readability of the `peak_rss_mb_max` expression in `eval.mjs` `evaluate`.
