---
ticket: AIS-BENCH-1 Wave 1 (GitHub issue #53; tracking issue #51)
branch: feat/AIS-BENCH-1-wave-1-baseline
run_id: w1-20261111-091721
timing_telemetry: active
native_plan_mode: active
plan_mode_carrier: claude
host_agent: claude
counterpart_agent: codex 0.166.0 (CodeRabbit 0.7.6 fallback)
plan_debate: {status: SKIPPED, reason: "STANDARD profile, not money or auth"}
worker_width: 3
parallelism_degradations: []
approval_status: approved
approved_via: ExitPlanMode on 2026-11-11 (one approval covering the Wave 0 and Wave 1 plans)
ui_required: false
owned_screens: []
review_profile: STANDARD
review_profile_reasons: ["issue #53 routing; no auth, tenancy, billing, schema or public API"]
review_timeouts: {primary: 12m, optional: 10m, confirmation: 6m}
base: main@65b84cd
execution: manual flow with Agent dispatch, as in the AIS-HARNESS-4 waves (engine helpers not used, declared degradation)
candidate_exclusions: [".claude", ".specs/reviews/AIS-BENCH-1/evidence", ".specs/plans/AIS-BENCH-1-wave-1.md", "session-log.md"]
session_log: not tracked in this repository, so no entry is written
---

# Plan — AIS-BENCH-1 Wave 1: baseline and seven-scenario bench (#53)

Branch `feat/AIS-BENCH-1-wave-1-baseline` from `main`, in its own work tree
(`.claude/worktrees/bench-w1`) · plan file `.specs/plans/AIS-BENCH-1-wave-1.md` ·
run `w1-20261111-091721`.

**Shape:** harness tooling (no FE/BE) · security-sensitive: no · review: STANDARD

## 1. What & why

After this wave the repository holds a measured baseline: which references each `ship-ticket`
phase loads and how many bytes, and one JSON result for each of seven fixture scenarios run
against the fake provider. Wave 2 is judged against these numbers. No engine file changes.

## 2. Integration contract and execution DAG

Integration contract: NOT_TRIGGERED — no producer/consumer boundary changes.

| ID | Owner | Step | Files touched | Depends on |
|---|---|---|---|---|
| load | builder | A script that reads the load table in `SKILL.md` and reports, per phase, the references loaded and their bytes, with and without units, and the bytes of opt-in unit text inside them. An unrecognised table row fails the script | `skills/ship-ticket/scripts/load-record.mjs` (new) | — |
| bench | builder | Extend the bench to scenarios S1 to S7 behind `--scenario`; one JSON result each. Today's `--nodes` call keeps its output | `skills/ship-ticket/scripts/engine-bench.mjs`, `skills/ship-ticket/scripts/engine-bench-scenarios.mjs` (new) | load |
| tests | builder | One test per scenario for what it must show, plus the load script's tests | `skills/ship-ticket/scripts/engine-bench.test.mjs` | bench |
| results | orchestrator | Run both scripts and check the results in, with a README stating the limits | `.specs/reviews/AIS-BENCH-1/baseline/README.md`, `load.json`, `scenarios.json` (new) | tests |
| join | orchestrator | Validator, then every suite one at a time | — | results |

The wave plan file is also committed. CI needs no change: `engine-bench.test.mjs` is already
in the matrix.

**Decomposition:** ONE unit (no unit fields). Rationale: one builder, one script family, no
shared contract.

**Scenarios** (as in #53): S1 one node · S2 contract, then frontend and backend in one wave,
then join · S3 auth-sensitive: ship-ready refuses without accepted RED and the required
evidence · S4 six nodes, two waves and a join · S5 provider error (one retry), timeout (no
retry), engine crash (resume, no second writer), worker crash with writes (a judgment) · S6 a
worker writes one extra file: ownership violation and a full stop · S7 UI change: ship-ready
refuses without parity evidence.

**Result per scenario:** `orchestrator_commands`, `bytes_read`, `reference_bytes`, `wall_ms`,
`nodes_completed`, `judgments`, `owner_interventions`, `proof_runs`, `retries`, and the facts
that show the scenario's point.

**What exists to reuse (checked now, so all seven are reachable with the engine frozen):**
- `engine-test-fixture.mjs` exports the repo fixture (`fixture`), a behaviour-driven fake
  provider (`FAKE_CLI`, `STAGED_BEHAVIOUR`), review inputs (`passReview`, `failReview`,
  `primaryReview`, `secondOpinion`) and `codes(status)` for judgments. Provider error,
  timeout, an extra file and a crash after writing are fake-provider behaviours (S5, S6).
- Engine crashes have no environment switch. The crash tests use the in-process `boundary`
  hook and `engine-crash-driver.test-helper.mjs` (a child that kills itself at a named
  boundary); the bench reuses those (S5).
- RED, review and ship-ready are recorded through `run-engine.mjs gate …` with a JSON input
  (S3, S7).
- **S7 caveat:** the engine has no UI flag of its own. The review gate refuses only when the
  review input says parity was triggered and gives no graded parity artifact
  (`gate.mjs:411`). S7 shows that refusal and records the missing independent trigger as a
  baseline observation.

## 3. Risks & unknowns

| Risk / unknown | Why it matters | What I'll do |
|---|---|---|
| A scenario cannot be driven without changing the engine | The engine is frozen and outside this contract | The builder stops and reports. That scenario is recorded as not reproducible with the reason, and I ask you before anything else changes |
| Results read as proof of quality | The provider is fake | The README and every result say: mechanism and orchestration overhead only |
| Wall time differs per machine | A checked-in number looks exact | Tests assert mechanism (counts, refusals, judgments), never time; the README names the machine and Node version |
| Longer CI | The bench test runs on six matrix legs | Scenario timeouts are short; the whole file stays under about a minute on POSIX; Windows keeps today's skip (limit N7) |
| Engine suites in parallel copies (#49) | False failures | Wave 1's build starts only after Wave 0's engine suites finish; one suite at a time |
| The load table has rows with conditions in prose | The script must map them | A declared map in the script; an unknown row fails, so Wave 2 has to update it |

### 3a. Security risk assessment

No security-relevant surface: no changed surface selects a catalog control under the cited facts (policy 2, catalog v1 `sha256:ed41751ae3b4392d197d98aff78bbd0f6c0461ae7fe6c3f224bf32718899e5b4`, selection `sha256:1aa85f168a0f9206eab7697e7664ffe0690b6345bc2c69be4f9cacdda16ad34c`, 0 surface(s), unknown facts: none).
security-pairs sha256:1abb57989a298cfe803f0ddb84d39890a3830ed58a41e41cd1bff6362a901edf
<!-- security-plan: {"catalog_digest":"sha256:ed41751ae3b4392d197d98aff78bbd0f6c0461ae7fe6c3f224bf32718899e5b4","controls":[],"facts":{"attempt_limit":false,"boundaries":[],"caller_triggered_debit":false,"identity_claim_unproven":false,"link_or_token_in_message":false,"outbound_message":false,"persistent_write":false,"plan_gated_feature":false,"principals":[],"recipient_unproven":false,"sensitive_field_write":false,"session_context":false,"shared_resource":false,"spends_or_reserves_value":false,"state_transitions":false},"pairs":[],"policy":2,"selection_digest":"sha256:1aa85f168a0f9206eab7697e7664ffe0690b6345bc2c69be4f9cacdda16ad34c","surfaces":[]} -->

## 4. How I'll prove it works

- **AC4:** `load.json` and `scenarios.json` exist in `.specs/reviews/AIS-BENCH-1/baseline/`,
  produced by the checked-in scripts; the README gives the commands to reproduce them.
- Each scenario's test asserts its point: S2 both sides start in one wave; S3 and S7
  ship-ready refuses; S5 one retry, no retry on timeout, no second writer after resume, one
  judgment; S6 an ownership violation and no further dispatch.
- The load script's byte counts equal the files' sizes on disk; a planted unknown table row
  fails it.
- The engine's golden test and every existing suite pass, one at a time. No engine file is
  in the diff.

## 5. Not in this ticket

- Any engine change. Real-ticket figures from `eval.mjs report` (they need your tickets).
- Any change to the references; Wave 2 splits them.

## 6. Rejected alternative

Hand-written byte tables in the baseline folder: Wave 2 must re-run the same measurement, so
it has to be a script.

## 7. Cross-model planning debate

**Result:** SKIPPED — STANDARD profile, not money or auth (roadmap section 8). Model
agreement is advice, not approval.

## 8. Proof and review routing

| Work | Scope for this ticket | Execution |
|---|---|---|
| parity | not triggered (no UI) | — |
| attack inventory | not triggered (section 3a) | — |
| rule coverage | `code-quality` hub for the scripts; `test-quality` on the test file; `docs-accuracy` on the README | one Opus primary review |
| second opinion (mandatory) | whole candidate | Codex, concurrent with the primary review; CodeRabbit if Codex fails |

Review timeouts: primary 12 min, second opinion 10 min, confirmation 6 min.

**Ship threshold:** default, as in Plan A.

## Shared facts (from the approved plan document)

Shared facts: base `main` @ `65b84cd`, CI green on it. No UI, so no design pin and no parity.
Stack: dependency-free Node >= 18 (ESM, `node:test`) plus Markdown skills. Host Claude;
second opinion Codex 0.166.0 (CodeRabbit 0.7.6 fallback), both present. Plan debate: SKIPPED
for both waves (STANDARD, not money or auth). Execution: manual flow with Claude Code
subagents, the same declared degradation the AIS-HARNESS-4 waves ran under
(`.specs/plans/AIS-HARNESS-4-wave-c2.md`, header `execution:`); the run engine is not used.
Builders Sonnet, primary reviewer Opus, at most 3 agents at once.

Candidate identity (`candidate-id.mjs`) hashes untracked files too. Both waves exclude
`.claude/` (local settings and work trees), the local `evidence/` folder, the wave's own plan
file and `session-log.md`. Nothing is ever staged with `git add -A`.

## Design Contract

Every path that may change. The routed skill is the `code-quality` hub, which has no contract
gate of its own, so this is the workflow-owned shape. "Hub core" means
`skills/code-quality/references/universal-principles.md` and `ai-failure-modes.md` (modes 1 to 15).

| File | Why (DAG step) | Role in this repo | Rules in force |
|---|---|---|---|
| `skills/ship-ticket/scripts/load-record.mjs` (new) | load | measurement script, dependency-free Node >= 18 | hub core; reads `SKILL.md`, writes nothing in the repository |
| `skills/ship-ticket/scripts/engine-bench.mjs` | bench | fixture benchmark CLI | hub core; today's `--nodes` output unchanged; imports engine modules, changes none |
| `skills/ship-ticket/scripts/engine-bench-scenarios.mjs` (new) | bench | scenario definitions and fake-provider behaviours | hub core; reuse `engine-test-fixture.mjs` before writing a helper |
| `skills/ship-ticket/scripts/engine-bench.test.mjs` | tests | `node:test` suite, already in the CI matrix | `test-quality` TEST-01…12; asserts mechanism, never wall time |
| `.specs/reviews/AIS-BENCH-1/baseline/README.md` (new) | results | baseline record | `docs-accuracy` DOC-01…10; states the fake-provider limit |
| `.specs/reviews/AIS-BENCH-1/baseline/load.json` (new) | results | script output | produced by `load-record.mjs`, not edited by hand |
| `.specs/reviews/AIS-BENCH-1/baseline/scenarios.json` (new) | results | script output | produced by `engine-bench.mjs`, not edited by hand |
| `.specs/plans/AIS-BENCH-1-wave-1.md` | plan artifact | this file | approved-plan digest |

Ownership: the builder owns the four paths under `skills/ship-ticket/scripts/`; the orchestrator
owns the rest. Forbidden: every other file under `skills/ship-ticket/` (the engine is frozen and
the references belong to Wave 2). Nothing else may be written.


<!-- RUN-STATE:BEGIN -->
<!-- Append one compact JSON object per execution event; never edit or reorder
     an existing entry. The event vocabulary is defined in ship.md. -->
{"event":"START","run_id":"w1-20261111-091721","timestamp":"2026-11-11T07:43:01.982Z","approved_at":"2026-11-11T07:43:01.982Z","approved_plan_digest":"sha256:de2fce133f8f73c8f5861e78c8e395c6e04de3013003fa1de9f619f2dbe7ca3d","digest_procedure":"planNarrativeDigest (run-engine.mjs): sha256 of the plan file with the text between the RUN-STATE markers removed","approved_by":"owner (ExitPlanMode, 2026-11-11)","base":"main@65b84cd"}
{"event":"DEVIATION","run_id":"w1-20261111-091721","timestamp":"2026-11-11T07:49:02.391Z","phase":"BUILD","what":"correction of a factual error in the approved narrative, section 2 'S7 caveat'; no scope, file or acceptance change","detail":"The plan says the engine has no UI flag of its own. That is wrong: a `ui` risk label (node `risk` or `config.riskLabels`) makes ship-ready refuse with `missing_risk_evidence` until `parity-measurements` evidence exists (harness.mjs RISK_EVIDENCE; gate.test.mjs 'seam: ship-ready unions ticket-level config.riskLabels with node risk; ui needs the parity-probe evidence'). S7 is built on that mechanism. Its stated point (ship-ready refuses without parity evidence) is unchanged, and no 'missing independent trigger' observation is recorded.","found_by":"orchestrator, while preparing the builder brief","narrative_edited":false}
{"event":"DEVIATION","run_id":"w1-20261111-091721","timestamp":"2026-11-11T08:24:11.383Z","phase":"BUILD","what":"second correction to the S7 note; no scope, file or acceptance change","detail":"The earlier DEVIATION said a `ui` label works on a node's `risk` or in `config.riskLabels`. Only `config.riskLabels` accepts it: `init` refuses a node-level `ui` with `dag_invalid` (allowed node labels: security, auth, tenancy, payments, migration, schema, shared-contract, concurrency). S7 uses `config.riskLabels: ['ui']`.","found_by":"builder, while building S7","narrative_edited":false}
{"event":"PROVE","run_id":"w1-20261111-091721","timestamp":"2026-11-11T08:47:58.756Z","candidate_id":"ceb1bdf6a40c1f4a1e2a88b32451e60419eedbe837460355ab122ee2af935f68","repair_batches":1,"commands":[{"cmd":"node scripts/cli.mjs validate","outcome":"PASS"},{"cmd":"node --test skills/ship-ticket/scripts/engine-bench.test.mjs","outcome":"PASS","detail":"18/18 on Node 22.23.1 and 18.20.8 (macOS), about 23 s"},{"cmd":"harness matrix suite (27 files)","outcome":"PASS","detail":"550/550 run alone, after the repair batch"},{"cmd":"ENGINE_MUTATION=1 seeded + mutation","outcome":"PASS","detail":"2/2 run alone; inputs unchanged by the repair batch"},{"cmd":"ENGINE_SECURITY_MUTATION=1 security mutation","outcome":"PASS","detail":"1/1"},{"cmd":"validate job tests (run-log, project-audit, marketing-video, vapt x3, security-audit)","outcome":"PASS"},{"cmd":"engine-bench.mjs --scenario all --json","outcome":"PASS","detail":"seven scenarios ok; three runs byte-identical apart from wall_ms"},{"cmd":"load-record.mjs --json","outcome":"PASS","detail":"266,053 bytes in 12 files; unit text 14,986 and 10,373 bytes: equal to the assessment's hand counts"}],"ac_evidence":{"AC4":"load.json, scenarios.json and README.md under .specs/reviews/AIS-BENCH-1/baseline/, produced by the checked-in scripts; README figures checked against the JSON by script"},"rules":{"TEST":"test-quality guard: no must-fix; ten advisories applied (relative-path filter, real byte comparison, wave assertions, deterministic S5 metrics, roomy crash timeout)","DOC":"docs-accuracy guard: two must-fix sentences in the README corrected (S6 scoped to width 1; the S6 regression sentence), six advisories applied"},"scope":{"engine_files_changed":0,"references_changed":0},"security":{"section_3a":"no security-relevant surface","reassess":"not run: manual flow, no engine state; the diff adds no route, auth path, migration or rendering sink"},"parity":"NOT_TRIGGERED","vapt":"NOT_TRIGGERED","degradations":["harness: manual flow with Agent dispatch (engine helpers not used)","Linux legs run only in CI; scenarios are skipped on Windows (N7)"]}
{"event":"REVIEW","run_id":"w1-20261111-091721","timestamp":"2026-11-11T08:53:29.681Z","review_execution":"review-w1bench1-a1","profile":"STANDARD","candidate_id":"ceb1bdf6a40c1f4a1e2a88b32451e60419eedbe837460355ab122ee2af935f68","primary":{"identity":"claude:opus","outcome":"FAIL","acceptance":{"AC4":"PASS"},"rule_rows":{"UNIVERSAL":"PASS","AI-FM":"PASS","TEST":"PASS","DOC":"FAIL"},"parity_outcome":"NOT_TRIGGERED","attack_review_outcome":"NOT_TRIGGERED","security_outcome":"NOT_TRIGGERED","findings":[{"id":"P1","severity":"major","path":"skills/ship-ticket/scripts/engine-bench-scenarios.mjs:148","summary":"S3 calls ship-ready with no risk evidence, so the missing-evidence list is identical before and after RED: the scenario never shows that ship-ready refuses because RED is not accepted","disposition":"fix","verified":"scenarios.json shows the same missing list before and after RED"},{"id":"P2","severity":"minor","path":"skills/ship-ticket/scripts/load-record.mjs:47","summary":"the comment says the spine states the codex-cli.md loads; the link is in references/cross-model.md","disposition":"fix"}],"not_verified":"a possible flake in S5's two-second timeout case, which relies on the fake provider logging before it is killed","duration_s":148},"second_opinion":{"route":"codex","identity":"codex:gpt-6","carrier":"codex-delegate relay, read-only, effort high, 10m watchdog","outcome":"PASS","findings":[],"security_surface_judgment":"agree"},"extra_in_batch":"the S5 timeout case is made independent of the fake provider's log (the reviewer's unverified flake concern)","outcome":"FINDINGS: one repair batch, then targeted confirmation"}
{"event":"REPAIR","run_id":"w1-20261111-091721","timestamp":"2026-11-11T09:03:34.974Z","review_execution":"review-w1bench1-a1","phase":"REVIEW","batch":1,"previous_candidate_id":"ceb1bdf6a40c1f4a1e2a88b32451e60419eedbe837460355ab122ee2af935f68","candidate_id":"0735d4aa292208a823ba2f3c6d482564c1f213d63b34cf75e65035aeacfa07df","findings":{"P1":{"paths":["skills/ship-ticket/scripts/engine-bench-scenarios.mjs","skills/ship-ticket/scripts/engine-bench.test.mjs"],"fix":"S3 supplies the two spec evidence entries and records three ship-ready results: before RED with evidence (both kinds missing), after RED with evidence (missing_risk_evidence gone), after RED with no evidence (both missing again); ok depends on all three","red":"the rewritten S3 test failed on the reviewed scenario","class_search":"S7 gains the complement (a supplied parity artifact clears the reason); S6 gains a control run of the same DAG without the extra file (completes, no judgment); S5 records and asserts the engine's own failure reasons"},"P2":{"paths":["skills/ship-ticket/scripts/load-record.mjs"],"fix":"each prose load names the file that states it (codex-cli.md: references/cross-model.md); two scenario comments that cited the wrong engine file corrected","class_search":"every source-of-fact comment in the four scripts re-read"}},"hardening":"the S5 timeout case reads its attempt count from engine state instead of the provider's log","orchestrator":["scenarios.json regenerated (load.json unchanged)","README rows S3, S6 and S7 and two observations updated; figures checked against the JSON by script"],"changed_paths":["skills/ship-ticket/scripts/engine-bench-scenarios.mjs","skills/ship-ticket/scripts/engine-bench.test.mjs","skills/ship-ticket/scripts/load-record.mjs",".specs/reviews/AIS-BENCH-1/baseline/scenarios.json",".specs/reviews/AIS-BENCH-1/baseline/README.md"],"reruns":[{"cmd":"node --test skills/ship-ticket/scripts/engine-bench.test.mjs","outcome":"PASS","detail":"18/18 on Node 22.23.1 and 18.20.8"},{"cmd":"harness matrix suite (27 files)","outcome":"PASS","detail":"550/550 run alone"},{"cmd":"node scripts/cli.mjs validate","outcome":"PASS"},{"cmd":"engine-bench.mjs --scenario all --json twice (builder: three times)","outcome":"PASS","detail":"identical apart from wall_ms"}],"reused_evidence":"seeded, mutation and security-mutation suites and the validate job's other tests: inputs unchanged by the repair"}
{"event":"CONFIRM","run_id":"w1-20261111-091721","timestamp":"2026-11-11T09:05:17.332Z","review_execution":"review-w1bench1-a1","candidate_id":"0735d4aa292208a823ba2f3c6d482564c1f213d63b34cf75e65035aeacfa07df","reviewer":"claude:opus","checked_findings":{"P1":"fixed: S3 passes the spec evidence boundRiskEvidence checks against RED; a rerun shows both kinds missing before RED, none after, both again with an empty list","P2":"fixed: each prose load names the file that states it, verified by grep"},"closure":{"regressions":[]},"rule_rows":{"TEST":"PASS","DOC":"PASS"},"security_outcome":"NOT_TRIGGERED","new_findings":[],"second_opinion_on_repair":"not required: the repair touches no concurrency- or security-labelled work","outcome":"PASS"}
{"event":"SHIP_READY","run_id":"w1-20261111-091721","timestamp":"2026-11-11T09:05:17.476Z","candidate_id":"0735d4aa292208a823ba2f3c6d482564c1f213d63b34cf75e65035aeacfa07df","approved_plan_digest":"sha256:de2fce133f8f73c8f5861e78c8e395c6e04de3013003fa1de9f619f2dbe7ca3d","review_execution":"review-w1bench1-a1","checks":["CONFIRM event PASS","approved-plan digest matches START","recomputed candidate ID equals the confirmed one","every candidate path is in the Design Contract","local commands green or reusable","only named paths staged"],"session_log":"not tracked in this repository"}
<!-- RUN-STATE:END -->
