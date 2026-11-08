# AIS-HARNESS-3: consolidated plan (Wave 0 follow-ups + adaptive units, incremental verification, measurement)

PLAN only. No BUILD without explicit owner approval. Planner: Opus subagent; independent debate: Codex. Does not touch StoreCraft work or unrelated worktrees. PR #38 stays unmerged (owner decision).

## Context
A ~14k-line Returns & Refunds ticket needed 3-4 full review/repair rounds. The harness treats a large ticket as one execution/review unit. Goal: handle large tickets more efficiently without weakening gates. No run-engine telemetry exists for that ticket, so **no savings are claimed; the plan measures first.** Also carries the PR #38 follow-ups (Windows CI, CodeRabbit, duplicate-END, N1/N2/N7).

## Key finding and OWNER POLICY DECISION (2026-11-08)
Problem: each of 5-6 rounds re-reviewed ~14k lines. Owner decision: **per-unit independent review is the main code inspection; the final review stays mandatory on the exact assembled candidate but becomes risk-focused and consumes verified unit evidence** (still inspects code in high-risk areas, still Opus primary + mandatory Codex second opinion, all gates unchanged). This changes how the final review is scoped, not whether it runs. Whether total cost/time/accuracy beats repeated full rounds is **unmeasured**; Wave 4 A/B decides, and the removal rule undoes it if not. Primary metric: fewer terminal final-review outcomes / owner RETRYs and fewer full-candidate review passes; guardrails below.

## Threat model (written first; absent in PR #38, the cause of its review loop)
- In scope: accidental/buggy workers (scope creep, undeclared writes, forgotten tests, stale inputs, crash mid-write, leftover dev-server descendants, flaky runners, wrong contract assumption, repeating the same repair).
- Out of scope: deliberately hostile dispatched code. PR #38 defences stay, but are not a review target. Reviewers get this paragraph; hostile-only findings are dispositioned `reject: out of scope (threat model)`.

## What exists (reuse)
DAG v1 `engine-dag.mjs:39-96` (flat, deps/reads/writes/resources/risk); `harness.mjs` conflicts/schedule/admit (advisory memory); node fingerprints + `closure()` stale invalidation (`engine-io.mjs:135`); `candidate-id.mjs` (whole tree); RED bound to spec digests + baseline; gate review chain/freeze/RETRY (`gate.mjs`, `engine-gates.mjs`); targeted confirmation; `eval.mjs`/`run-summary.mjs` (tokens by role, wall, rounds). Gaps: no per-node acceptance criteria or focused checks; no `prove` repair producer; no per-unit view; no peak RAM/CPU; no worktrees/rollback; no feature-flag mechanism (config = DAG JSON).

## Debate outcomes (Opus + Codex agree unless noted)
| Topic | Decision |
|---|---|
| Flat vs hierarchical | Flat DAG + optional `unit` tag/membership. No nested schema or sub-engines. |
| Single vs incremental review | **Incremental (owner decision).** Per unit: deterministic gates (acceptance mapping + focused checks) then independent Opus review (Codex second opinion on risky units; CodeRabbit fallback). Final review on the exact assembled candidate stays mandatory, risk-focused, consuming unit evidence. Opt-in via the unit fields; flag-absent runs keep today's full-candidate review byte-identical. |
| Full vs selective re-review | Selective: a repair re-reviews only its unit (plus dependents only if a shared contract changed). Evidence is recomputed against unit code, inputs and contract versions before reuse; any change invalidates it. Fingerprint refresh after repair is never renewed validity (Codex). Full re-review only on owner RETRY. |
| One-time vs incremental assembly | No assembly step exists. Same checkout; quiescent checkpoints; conflict-free scheduling + ownership checks. Worktrees/rollback deferred until measured need. |
| Static vs adaptive | Adaptive at PLAN (planner picks 1 vs N units, human approves); static at run time (DAG_BOUND). No run-time re-decomposition. |
| LLM vs deterministic | LLM proposes/judges; engine enforces. |
| Review Certificates | Rejected as a stored artifact. Build a computed **unit projection** in `status`/`eval` from existing evidence; bind both merge-base and candidate digest. |
| Complexity | Every addition optional, absent by default, byte-identical when absent (golden test); fields with no measured win are removed. |

## BUILD NOW / DEFER / REJECT
- **Build now:** Wave 0 follow-ups; peak RSS/CPU sampling + new eval metrics; optional `unit`, `acceptance`, `checks` node fields with pre-freeze deterministic unit checks, AC-coverage validation at init, unit projection; planner heuristics + repair-routing table + review partition briefs from units; parent-wide retry/repair ceiling (unit count must not multiply allowances); recorded cause for every review/repair cycle and invalidation; A/B measurement.
- **Also build now (owner decision):** per-unit independent LLM review (Wave 2), unit-scoped repair + re-review, final review scoped to risk on top of unit evidence (Wave 3).
- **Defer:** worktrees/isolation/automatic rollback; parallel repairs; concurrent review+build; memory reservation; `prove`-repair producer (owner may pull into Wave 0).
- **Reject:** nested schema; stored Review Certificate authority; LLM orchestration/run-time re-decomposition; skipping the final review or accepting it on aggregated unit PASSes alone (it must still inspect high-risk code on the exact candidate); automatic RETRY; configurable round limits that weaken policy; silent API billing; unmeasured claims.

## Waves (each its own PR and bounded review)
**Wave 0: PR #38 follow-ups** (depends on nothing; first)
1. Windows CI: documented POSIX-only skips with reasons for the 3 failing tests; no Windows support claim.
2. Duplicate-END: `run-state.mjs` requires exactly one BEGIN/END, classify authority from BEGIN to last END; test per variant; small review-5 items (verifyApproval unparsed lines, pgid-reuse guard, normalization message).
3. N1 (`mark failed->pending` clears spent judgments, recorded), N2 (re-run RED when spec/base change), N7 documented.
4. CodeRabbit: one triage pass over all comments (untrusted data; verify each vs code): fix / reject (cite code or threat model) / defer. Likely fixes: engine-io short write + rename paths, usage normalization, bench test, doc quoting, gate risk-evidence path. Owner decides heavy items: `launcher.mjs:61` (lean fix: complete on exit then retire group), `engine-io.mjs:153` (lean reject under threat model), `review.md:47`, `SKILL.md:425`.
5. Module sizes trimmed only where mechanical in touched files.
Ship threshold: suite green twice on POSIX, Windows green via skips, `cli.mjs validate`, exactly one review execution with threat model in briefs; a FAIL goes to the owner, who commits to at most one RETRY, then ship with disclosed limits.

**Wave 1: instrument first (no behaviour change)**: peak RSS/CPU over process group in launcher envelope (unknown on Windows, never zero); eval adds `peak_rss_mb`, `parallel_efficiency`, `terminal_review_outcomes`, `retries_authorized`, `cost_per_accepted_ticket`; optional read-only importer counting Returns&Refunds rounds from Claude session JSONL (only if owner permits).

**Wave 2: units behind presence of fields** (no schema bump): `unit`, `acceptance[]`, `checks[]` additive in v1; engine runs unit `checks` via the existing runner protocol (quiescence, locks, retry cap 1) before freeze; node done only if checks pass; unit evidence bound to fingerprints so contract/input change invalidates the unit closure; invalidation-storm guard (recurring broad invalidation escalates to a judgment instead of re-reviewing); `status`/`eval` unit projection.
- **Unit review (core of Wave 2):** after a unit's nodes are `done` and checks pass, at a quiescent checkpoint (no live writer on its files), the engine records a unit review chain: Opus primary (review-only relay, builder-independent, as today's reviewer rules) + Codex second opinion for risky units (CodeRabbit fallback; stop and ask if none can run). Review input is the unit's exact files/diff, its acceptance criteria and contract versions. Result is a machine-readable unit record bound to: approved-plan digest, DAG digest, unit id, merge-base + candidate digest, input/output fingerprints, dependency/contract versions, check-artifact digests, reviewer identities, findings, outcome. Recomputed before every reuse (computed projection, not a trusted certificate). Unit repair: finding-bound REPAIR limited to the unit's write set, 1 repair + 1 targeted confirmation per unit, under a **parent-wide ceiling** (unit count must not multiply the allowance; reserve budget for the final review). Units may be reviewed in parallel subject to the width and memory limits. Per-cycle trigger reason recorded.

**Wave 3: planner + review integration**: `plan.md` decomposition heuristic (one unit if small/tightly coupled; split at contract seams/AC boundaries); `review.md` routing table (local defect -> unit writes; shared contract -> contract + readers' closure; integration -> integration node + affected tests; security/architecture -> full closure + second opinion on repair); `gateReview` additionally requires every mapped `acceptance` id in the review's criteria coverage (stricter, not weaker). Final review brief: scoped to risks not verifiable per unit (cross-module behaviour, end-to-end ACs, security/authz, tenancy, state/concurrency, payment/refund idempotency, DB consistency, contracts, drift, assembly regressions); receives valid unit records, refuses any whose recomputed binding is stale; must still inspect code in high-risk areas; exact assembled candidate, Opus primary + mandatory Codex second opinion, unchanged overflow/RETRY policy.

**Wave 4: A/B measurement and decision gate**: keep/defer/remove Wave 2 fields.

## Acceptance criteria
- W0: items above pass; CodeRabbit disposition table committed; ship threshold met.
- W1: eval prints new metrics, `unknown` where no data; sampler overhead <2% of wall on bench fixture (measured).
- W2: (i) v1 DAG without new fields yields identical state/events (golden); (ii) failing `checks` blocks `done`; (iii) editing a contract a unit reads invalidates its check evidence + closure only; (iv) unmapped plan AC id is `dag_invalid` at init when any node has `acceptance`; (v) status shows per unit nodes, fingerprints, check evidence, candidate, state; (vi) unit count cannot multiply retry allowance.
- W3: `gateReview` refuses a review omitting a mapped AC id; `cli.mjs validate` passes.

## Measurement and success criteria (pre-registered)
- Primary: fewer terminal final-review outcomes / owner RETRYs per large ticket.
- Guardrails (must not worsen): findings by severity pre-ship, escaped defects (14 days), total tokens incl. orchestrator, cost per accepted ticket, wall clock, peak RSS.
- Removal rule: after n>=3 large tickets per arm, if primary not better and cost up >15%, remove Wave 2 fields.
- Design: baseline with current harness first; alternate arms across tickets matched on LOC band/files/risk/stack, arm chosen before PLAN, same models/policy. Disclose: small n, non-identical tickets, planner learning, Returns&Refunds predates the engine (historical round count only, no cost comparison), RAM = sampled peaks, fixture results are not real-ticket savings, wall-clock overlap is not causal time saved. Subscription list-price estimates kept separate from actual charges.

## Failure-scenario validation (Wave 2 tests)
Worker crash (incl. mid-check); crash during check/integration then `resume` (`quiescence_unknown` path); stale unit evidence after input change; shared-contract change re-runs only dependents; concurrent edits to shared files (`conflicts()` + `ownership_violation`, add unit-level case); integration failure (node fails, retry<=1); dependency invalidation with check evidence; repeated repair loop (unit check fails twice -> judgment, ceiling holds); resource exhaustion (budget_stop/admission; peaks recorded, reservation deferred); resume after 3-of-5 units done. Bench: 6-node fixture extended to a 3-unit fixture for both arms.

## Verification of this plan's later BUILD
Full suite twice, `node cli.mjs validate`, golden no-change test, new tests per AC, bench rerun, review under unchanged policy (Opus primary + Codex second opinion, CodeRabbit fallback).

## Open questions for the owner (answer at approval)
1. Numeric "large" threshold (e.g. >2k changed LOC or >2 contract seams)?
2. Which new (not running) StoreCraft tickets are A/B candidates?
3. May the Returns&Refunds Claude session JSONL be read read-only to count rounds?
4. Windows a target, or POSIX-only?
5. Heavy CodeRabbit items (`launcher.mjs:61`, `engine-io.mjs:153`, `review.md:47`, `SKILL.md:425`) in Wave 0 or deferred?
6. `prove`-repair producer into Wave 0?
7. Accept the removal rule?
8. ~~Per-unit LLM review~~ DECIDED 2026-11-08: build in Wave 2, opt-in, measured; final review becomes risk-focused (see Key finding).
Decided: CodeRabbit in Wave 0 = fix `launcher.mjs:61` only; reject `engine-io.mjs:153` under the threat model; `review.md:47` and `SKILL.md:425` triaged as doc fixes. Windows = POSIX only (skips with reasons). Decided 2026-11-08: no numeric "large" threshold. The planning AI judges whether a ticket should be split, and must record in the plan a split/no-split rationale (independent boundaries, contracts, ACs, ownership, expected size/risk, overhead vs value) for the human to approve. Size and file counts are reported as signals, not triggers; Wave 1 data may later suggest a default. Still open: which waves to start (recommend Wave 0 only); defaults assumed unless the owner objects: A/B tickets chosen later, session logs read-only for round counts, no prove-repair producer in Wave 0, removal rule accepted.

## Wave 4 pool (owner decision 2026-11-08)
- SCRUM-307 (API keys + read-only public API v1) is the first test ticket. Arm: **baseline = current harness, unit fields absent**, assigned before its PLAN. Run it in its own fresh Sonnet session after Wave 1 lands (so peak RSS/CPU and the new eval metrics are recorded) and before Wave 2 is enabled. Description size not yet verified; confirm it is large at PLAN time (planner's split rationale applies).
- Remaining pool candidates (arms assigned later, before each PLAN): SCRUM-195, 192, 156, 158, 75. Never Returns & Refunds (SCRUM-74, 401-404) or any running ticket.
