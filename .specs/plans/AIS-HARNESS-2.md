---
ticket: AIS-HARNESS-2 (local key; AI-Skills has no tracker — degradation recorded)
run_id: ais-harness2-20261105
native_plan_mode: active
host_agent: claude (opus — strong-model planning)
counterpart_agent: codex (relay, read-only)
plan_debate: {max_calls: 3, total_timeout: 20m, status: CONVERGED — r1/r2 NEEDS_CHANGES reconciled; r3 confirmed all r2 fixes, its 2 new majors accepted as written (no 4th call: budget reached)}
branch: fix/ship-ticket-wave-plan-mode (PR #38 — owner asked to extend the same PR)
review_route: {primary: opus (code + architecture + security), second_opinion: codex (CodeRabbit fallback)}
review_policy: the skill's existing rules, unchanged (fix in-scope minors; at most two consolidated PROVE repair batches per ticket in total, SKILL.md:287; one REVIEW repair + one targeted confirmation per authorized review execution; a terminal failure needs an explicitly authorized retry)
---

# Plan — Evolve the ship-ticket execution harness: durable engine, enforced gates, measurable cost

## Context

Three StoreCraft tickets (SCRUM-140, 96, 393) shipped through the harness. Measured:
- **The orchestrator drives cost:** about 226M cache-read tokens in the orchestrator session, against about 75M across all Sonnet workers ($36 list for three tickets). Every dispatch, log and gate step is an orchestrator turn that re-reads the whole context.
- **The LLM drops mechanical bookkeeping:**
  - the SCRUM-393 run log is still `open`;
  - a directory `--exclude` silently changed the candidate ID;
  - ownership false alarms;
  - repair workers skipped writing tests first.
- **Review takes longer than build:** on 140/96 review took 89 minutes against 67 for build, and 393 needed 3 review rounds.

The UNDERSTAND audit covered about 1,800 script LOC and 83 tests. The harness is a set of **stateless helpers**:
- `harness.mjs` `validateNodes` and `schedule` return static waves;
- `carrier.mjs` `dispatch` runs one node;
- DAG progress, retries, gate transitions (RED, review PASS, SHIP_READY), staleness and resume are prose the LLM executes;
- worker output is free text;
- orchestrator and reviewer usage is not captured, and there are no budgets;
- `candidate-id.test.mjs` is not in CI.

**Outcome wanted:** code runs the process and the LLM makes the judgments. That means fewer orchestrator turns per ticket, durable and resumable state, and gates that cannot be skipped silently, without weakening PLAN, approvals, review independence, the billing guard or candidate integrity.

## Scope: increment 1 (this PR)

### P0-1 Durable run engine: `scripts/run-engine.mjs` (new; Node built-ins only)
**Versioned schemas.** `ship-ticket-engine-dag-v1` is the DAG input. `ship-ticket-engine-state-v1` is the ledger at `git rev-parse --git-path ai-skills/ship-ticket/<TICKET>.state.json`, which is never committed. Unknown fields are rejected, never silently dropped. Two sections are enumerated separately, with every field mapped:
- **run config:** `provider`, `modelMap`, `permissionMode`, `billing` (subscription by default; api only with the existing `allowApiBilling`), `width`, `memoryBudgetMb`, `timeoutMs`, `budget`, `candidateExclusions` (pinned), `testCommands` (per runner adapter), `base`.
- **node:** `id`, `deps`, `reads`, `writes`, `othersOwned`, `resources` (the existing scheduler locks for ports, databases and caches), `risk`, `complexity`, `modelTier`, `estimatedMemoryMb`, `promptFile`, `phase` (`BUILD|PROVE|REPAIR|SHIP`), `role`, `evidence`, `redSpecs`.

All execution-affecting configuration is inside the bound DAG digest. **REVIEW is never dispatched by the engine.** It stays on its existing read-only route, and the engine only records its artifacts through `gate`.

**Approval binding.**
- `init` recomputes the plan narrative digest, i.e. the plan file excluding the RUN-STATE block, using the same procedure the skill uses for `approved_plan_digest`. It requires that digest to equal the digest in the approved START event, so no new trust is established from the current bytes.
- The DAG JSON digest must be listed in the approved plan, or recorded by one `DAG_BOUND` RUN-STATE event in the same run, written at approval time before the first dispatch. `DAG_BOUND` cannot be rewritten or superseded; rebinding requires a new approved START (back to the human).
- Every `drive` re-verifies both digests before dispatching. Any mismatch is a judgment point (back to the human).

**Lock and persistence protocol.** Every mutating command uses one lock:
- **Lock file:** created with `O_EXCL`, holding `{pid, process_start_time, host, run_id, nonce}`.
- **Who may break it:** only the same host, and only when the PID is dead, or alive with a different start time (PID reuse). A foreign host or a malformed lock is refused with a recovery instruction. Concurrent recovery is decided by `O_EXCL` on a recovery marker.
- **State writes:** write a temp file, `fsync`, rename, then `fsync` the directory. On Windows, retry `EPERM`/`EBUSY` a bounded number of times.
- **Ordering:** the state commit comes first. Run-log append and RUN-STATE append happen after it, using idempotency keys (event ids), so a replay never duplicates an event.
- **Testing:** fault injection through injectable fs hooks at every persistence boundary.

**Attempts and crash safety (launch handshake).**
1. Persist the launch intent `{attempt_id, node, pre_snapshot_digest}` (a state commit).
2. Spawn a small launcher in its own process group. It blocks on a release byte from the parent before it execs the provider CLI. If the parent dies first, the launcher's stdin closes and it exits without running the worker.
3. Persist `{pid, pgid}` (a state commit), then send the release byte.
4. On exit, write the completion envelope atomically: the existing result/message files plus `attempt_id`.

`resume` reconciles each attempt:
- envelope present → recorded;
- any process in the group still alive → wait or refuse; never a duplicate writer;
- group gone with no envelope → compare against the pre-snapshot. No relevant writes → may be re-queued. Writes → judgment point.

**Quiescence** means the whole process group is gone (POSIX `kill(-pgid, 0)` returns ESRCH). On Windows, descendants can escape (`carrier.mjs:305`), so unknown quiescence is a judgment point. Automatic retry only covers spawn failures and provider errors with proven quiescence and no relevant writes; a timeout or tree-kill alone is not enough. Retries are capped at 1 per node and logged. Tests crash the engine between intent, spawn, pid persistence and release.

**Staleness.**
- Each completed node stores fingerprints (existence, type, mode, content hash; not mtime) of its declared reads and writes.
- On resume or drive, a changed input or output marks that node and its dependency closure `stale`.
- `changed_paths` is the net filesystem change, excluding paths owned by concurrent siblings.
- Stale nodes re-run automatically only before the REVIEW freeze.
- After the freeze, **unexpected drift** is a judgment point. The **authorized repair transition** is a separate case: a `gate review` FAIL opens one REPAIR whose write set is bound to the findings (the paths the findings name, plus the declared repair ownership). Writes outside it are violations. The candidate is then recomputed, and the targeted confirmation covers the affected closure. Counters are never reset.

**Commands.**
- `init`.
- `status`: compact JSON, the only thing the LLM reads.
- `drive [--until node]`: continuous dispatch of ready nodes through `admit`.
- `resume`.
- `mark <node> <transition> --reason`. Its legal transitions are limited to `failed→pending` (counts as an attempt and is capped) and `pending→cancelled`. It can never mark nodes done, create gate evidence, change ownership, enable API billing or reset round counters.

**Round counters.** These follow the skill's limits:
- at most two consolidated PROVE repair batches per ticket, in total;
- one REVIEW repair and one targeted confirmation per authorized review execution.

Going beyond them, or a terminal failure, is a judgment point that needs an explicitly authorized retry, recorded as such.

**REPAIR authorization comes from engine state** (the gate review chain), not from the timing log. The existing run-log REVIEW-start check (`carrier.mjs:129-143`) becomes a fallback used only when there is no engine state file. A missing or unwritable log only degrades telemetry.

### P0-2 Gate verifier: `scripts/gate.mjs` (new)
Gate state is authoritative and lives in the engine state file under the lock. Timing logs stay best-effort and never block (SKILL.md:63).
- **`gate red` is a scheduler prerequisite:** production nodes that depend on RED nodes, repairs included, cannot be dispatched until RED is accepted.
  - The engine runs the declared command itself, with a bounded timeout, its own process group and the resource locks. It is not a provider dispatch, so carrier billing is untouched. Gate-run commands use **the same durable attempt protocol** as workers: launch intent, launcher handshake, pid persistence, envelope, and process-group quiescence before any re-run. A crash test covers a surviving runner holding a resource lock.
  - The evidence is runner-produced and bound to the **spec files' content digests** and the tested baseline candidate.
  - **Runner adapters:** `node --test` TAP (including nested subtests), vitest JSON and jest JSON.
  - Accepting RED needs every named spec to report an **assertion failure**. Import, compile or collection errors don't count (review.md:42).
  - Runner output the adapters don't support cannot establish RED. That is a judgment point; the documented manual flow applies, marked degraded.
  - Ordering is by event sequence, not wall clock.
- **`gate review`:** accepts a review only with all of these bound:
  - the primary review artifact matching the review.md output contract, complete;
  - a reviewer identity distinct from every builder identity in the state;
  - the frozen candidate ID;
  - coverage, parity and security outcomes;
  - the second-opinion artifact (route, candidate) and the reconciliation record.

  It tracks the original review → repair → targeted confirmation chain by `review_execution` ids. Counts or a route name alone are never accepted.
- **Candidate integrity:**
  - The exclusion list is pinned at `init`: exactly the ticket plan file and `session-log.md`. It is stored in the state and reused for every identity check, and the engine refuses directory or extra exclusions.
  - Parity and VAPT evidence stay **inside** the candidate and are **finalized during PROVE** (design-parity.md:28-31). Reviewers return their verdict plus the digest of the artifact they graded; that record lives in gate state, outside the candidate. A clean PASS needs no artifact rewrite and no confirmation round. Any later change to the artifact changes the candidate and is caught.
  - Tests cover a changed exclusion list and evidence altered after review.
- **`gate ship-ready`:** requires the current candidate to equal the reviewed candidate, an accepted review chain, local proof (tests plus the project's local gates) bound to that candidate, and required risk evidence. Only then does it emit `SHIP_READY`. Remote CI is checked afterwards, as today. The workflow closes at its real terminal outcome, and crashes record `interrupted`; no successful closure is ever synthesized.

### P0-3 Structured worker completion (carrier)
- The carrier adds `changed_paths`, the net change from its own snapshot, so it doesn't trust the worker's word.
- Worker prompts end with a fenced `ship-ticket-report` JSON block: `{tests:[{cmd,result}], red_seen:[], blockers:[], needs_outside_ownership:[]}`. The carrier validates it into the message file. When the block is invalid or missing, the carrier records `report:"unstructured"` plus failure metadata and the free text. That is not fatal, but `status` exposes it.
- Add `role` to every usage event (`builder|repair|evidence`, set from the node).

### P1-4 Cost attribution and budgets (`usage.mjs`, `run-summary.mjs`)
- **Totals by basis:** totals are partitioned by `cost_basis`, using only the existing allowed values, and different bases are never summed.
- **Sources don't overlap by construction:**
  - Carrier events are the only source for worker processes: one aggregate per `attempt_id`. Workers run with `--no-session-persistence`, so they leave no transcript.
  - Session import covers only the host session and its in-process subagents.
  - Codex relay usage is a separate source.
  - Every record carries `source` and `source_execution_id`. Importing an execution already present from any source is refused; the aggregate wins over detail.
  - Counters are normalized per provider into the existing COUNTERS. The phase comes from the engine's attempt or the import window.
- **Budget metric:** `processed_tokens = input + output + cache_read + cache_write` (configurable to `output_tokens`). Totals are refreshed from all sources before every dispatch, and an import older than the current wave is flagged stale. A test imports the same execution through two sources and checks the totals don't change.
- **Imports:**
  - `usage.mjs import-session <jsonl> --since --until --role orchestrator|reviewer` reads the main session and its `subagents/*.jsonl`. It keeps the last revision per message id and assigns roles by file and run window.
  - `import-codex <relay result.json>` only where the relay reports usage. Otherwise it records `unknown`, never an invented number.
- **Budgets** are `budget: {ticket_tokens, phase_tokens}` in the DAG. They are **dispatch thresholds**: a warning at 80%, and at 100% no new dispatch, which is a judgment point. Work already in flight can overshoot, and that is reported. When usage is unknown, the run is flagged `budget_unenforceable` rather than treated as within budget. Budgets never change review or model policy.
- `run-log summary` joins usage to give per-role tokens, the orchestrator share and cost per accepted ticket.

### P1-5 Risk-based verification (`harness.mjs` map, enforced by `gate ship-ready`)
This is **additive only**. Each label requires declared evidence kinds, each tied to a spec path and, where it applies, RED evidence:

| Label | Evidence |
|---|---|
| concurrency | interleaving/ordering spec |
| auth, security | negative and authorization specs |
| tenancy | cross-tenant spec |
| payments | idempotency and failure-path specs |
| migration, schema | replay and rollback/compat check |
| UI | parity-probe measurements file |

Presence is checked in code; the reviewer judges adequacy. No label removes a gate.

### P2-6 Evaluation metrics (`run-summary.mjs` + `scripts/eval.mjs`, read-only)
Metrics across runs:
- tokens by role and the orchestrator share;
- wall clock per phase;
- review and repair rounds;
- pre-ship findings by severity, taken from `gate review` records;
- resume attempts and outcomes;
- infra retries;
- admission refusals.

Recommendations are limited to three evidence-backed rules, printed as suggestions only and never editing policy:
- orchestrator share above 50% → split the session;
- review/build above 1.2 on a UI ticket → run the parity probe first;
- more than 1 REVIEW repair → the brief was too weak.

### Docs and CI
- **`SKILL.md`, `references/execution-harness.md` and `references/review.md` (gate usage only):**
  - the orchestrator drives with `run-engine` and `gate` instead of hand-run loops;
  - judgment points are listed;
  - the Resume section points to `run-engine resume`;
  - the manual flow stays documented as the fallback;
  - **PLAN phase text is untouched.**
- **`validate.yml`:** add `candidate-id.test.mjs` and every new test file to the 3-OS × Node 18/22 harness matrix.

## Non-goals (deferred until a real ticket measures the need)
- **Worker worktree isolation and join:** evaluated, deferred. It needs a defined source state for uncommitted dependency outputs, a staged join away from the user's index, drift detection and idempotent join records. It also duplicates installs in Nx monorepos. Ownership checks plus the new fingerprints cover today's failure modes.
- Changing PLAN, approvals or review independence.
- An autonomous LLM loop.
- Auto-weakening policy.
- Gemini/Antigravity adapters.
- Cross-machine execution.
- New npm dependencies.

## Execution DAG (builders Sonnet; `strong` where labelled)
| Node | Files owned | Depends | Risk / tier |
|---|---|---|---|
| seams | stub `scripts/run-engine.mjs`, `scripts/gate.mjs` with exported signatures that throw `not_implemented` (no behaviour; SKILL.md:437 seam allowance) | none | none |
| red-engine | `scripts/run-engine.test.mjs` (must fail on behavioural assertions against the seams, not imports) | seams | concurrency → strong |
| red-gate | `scripts/gate.test.mjs` (behavioural assertions against the seams) | seams | security → strong |
| red-carrier | `scripts/carrier-usage.test.mjs`, `scripts/usage.test.mjs` (new) | none | none |
| carrier | `scripts/carrier.mjs` (onSpawn, envelope, changed_paths, report, role), `scripts/usage.mjs` | red-carrier | none |
| gate | `scripts/gate.mjs` (ownership handed over from `seams`), `scripts/harness.mjs` (risk → evidence map, exported) | red-gate | security → strong |
| engine | `scripts/run-engine.mjs` (ownership handed over from `seams`) | red-engine, carrier, gate | concurrency → strong |
| eval | `scripts/run-summary.mjs`, `scripts/eval.mjs`, `scripts/eval.test.mjs` | carrier, gate | none |
| docs-ci | `SKILL.md`, `references/execution-harness.md`, `references/review.md`, `.github/workflows/validate.yml` | all | none |

Waves: [seams] → [red-engine, red-gate, red-carrier] → [carrier, gate] → [engine, eval] → [docs-ci]. Each file has one owner at a time; `seams` hands over to `engine` and `gate` once RED is accepted. Shared schemas live in the module that owns them, and the engine imports them. **Note:** this build runs on the current harness (carrier with `redSpecs`/`redEvidence`), because the new engine doesn't exist yet.

## Acceptance criteria (RED first; each maps to tests)
1. **Approval:**
   - init and drive refuse a plan narrative or DAG digest that doesn't match the approved START/DAG_BOUND;
   - `mark` cannot produce done/gate/ownership/billing/round changes.
2. **Lock:** a second mutator refuses; a dead PID or reused PID is recovered on the same host; a foreign host or malformed lock is refused; concurrent recovery has one winner.
3. **Persistence:** fault injection at each boundary (temp write, rename, dir fsync, run-log append, RUN-STATE append) leaves a state that `resume` reconciles without duplicate events. Windows rename retry is covered.
4. **Crash:**
   - an engine crash between intent, spawn, pid persistence and release never leaves an unrecorded running worker (launcher handshake test);
   - Windows unknown quiescence → judgment point;
   - live process → no duplicate writer;
   - dead with envelope → recorded;
   - dead without envelope and no writes → re-queued;
   - dead with writes → judgment point;
   - timeout or tree-kill alone → no automatic retry.
5. **Staleness:** a changed read input, a changed or deleted output, or a dependent node invalidates the dependency closure. Timestamp-only changes don't. Post-freeze changes stop with a judgment point.
6. **Gates:**
   - RED gates dispatch: a production node that depends on unaccepted RED is not dispatched; the TAP-nested, vitest and jest adapters accept assertion failures and reject import/compile errors; unsupported output → judgment point;
   - an authorized REPAIR may write only its finding-bound set, and the confirmation covers the closure; a REPAIR is authorized from engine state even when the run log is missing or unwritable, and an unauthorized one is refused;
   - RED: refuses evidence recorded after a dependent production dispatch, or specs that don't fail;
   - review: refuses missing second opinion, builder identity reuse, an incomplete contract or a stale candidate;
   - ship-ready: refuses a candidate mismatch, an altered exclusion list, a parity artifact whose digest ≠ the reviewed one, missing risk evidence, or missing local proof.
7. **Carrier:** `changed_paths` equals the net change excluding siblings; the report block works when valid, invalid or missing; the attempt record and envelope are written; existing ownership tests stay unchanged.
8. **Usage:** no cross-basis sums; session import dedupes against a fixture; budgets warn at 80%, stop at 100% with in-flight overshoot reported, and unknown usage gives `budget_unenforceable`. Importing the same execution through two sources doesn't change totals.
9. **Eval:** metrics on fixture runs, and the three rules fire only on their conditions.
10. **No regressions:** the existing 83 tests pass, `cli.mjs validate` passes, and every test file runs in the CI matrix.

## Measurement (no unmeasured claims)
- **Fixture benchmark:** a fake CLI and a 6-node DAG. Compare orchestrator tool calls, and state reads by the orchestrator, for the hand-run loop vs `run-engine drive`. Report measured counts in the PR.
- **Real savings:** reported only after the next real ticket runs through it, using `eval.mjs` against the 140/96/393 baseline.

## Risks and rollback
The engine and gate are additive, and the manual flow keeps working. Rollback means reverting the PR; state files are git-path scratch. Size target: each new module ≤ ~450 LOC.

## Verification
- `node --test skills/ship-ticket/scripts/*.test.mjs`
- `node scripts/cli.mjs validate`
- the fixture benchmark
- a scratch-repo dry run of `init → drive → kill → resume → gate red/review/ship-ready` with the fake CLI
- then an Opus primary review and a Codex second opinion on the exact candidate; the PR stays unmerged.

## 7. Cross-model planning debate
**Round 1 (Codex): NEEDS_CHANGES.** 12 points, all reconciled:

| # | Point | How it was reconciled |
|---|---|---|
| 1 | Policy relaxation (blocker) | Accepted. The ship-threshold header and the 2-round caps are removed; the skill's counters stay, and further rounds need owner authorization. |
| 2 | API and DAG incomplete | Accepted. Versioned schemas, `validateNodes`, explicit field mapping, REVIEW kept on its own route, gate → engine dependency. |
| 3 | Approval and `mark` bypass (blocker) | Accepted. The approved digest is verified rather than re-trusted, the DAG is bound by digest, and `mark` transitions are restricted. |
| 4 | Crash duplication (blocker) | Accepted. Attempt records, completion envelope, writer quiescence, and no retry on timeout or kill alone. |
| 5 | Lock and durability | Accepted. One lock protocol, PID-reuse and host checks, fsync ordering, idempotency keys, fault injection. |
| 6 | Input staleness and dependents | Accepted. Fingerprints of reads and writes, invalidation of the dependency closure, no mtime, stop at the freeze. |
| 7 | RED provenance | Accepted. Runner-produced evidence and ordering by sequence, repairs included. |
| 8 | Review binding (blocker) | Accepted. Full artifact chain, reviewer identity, second-opinion and reconciliation records. |
| 9 | Parity exclusion (blocker) | Accepted. Parity stays in the candidate, its digest is bound at review, and the exclusion list is pinned. |
| 10 | Worktree join | Accepted by deferring it to a later increment (non-goal). |
| 11 | Usage semantics | Accepted. Partitioned by basis, dedupe keys, threshold semantics, unknown handling. |
| 12 | Telemetry blocking SHIP, lifecycle | Accepted. Gate state is authoritative and logs are best-effort; local proof before SHIP_READY, remote CI after; no synthesized closures. Recommendations trimmed to three rules. |

**Round 2 (Codex): NEEDS_CHANGES.** Points #3, #5 and #10 were confirmed resolved. The remaining 8 were reconciled:

| # | Point | How it was reconciled |
|---|---|---|
| r2-1 | Repair limits | Two PROVE batches per ticket in total; one REVIEW repair and one confirmation per authorized execution. |
| r2-2 | Schema | Run and node config enumerated (resources, provider, model map, timeout, billing, exclusions, test commands), all inside the bound digest; `DAG_BOUND` can't be rebound. |
| r2-3 | Unrecorded writer (blocker) | Launch intent → launcher handshake → pid persisted → release; process-group quiescence; unknown on Windows → judgment point; crash-window tests. |
| r2-4 | RED barrier | A scheduler prerequisite, bound to spec digests and the baseline; runner adapters; assertion failures only; unsupported output → judgment point. |
| r2-5 | Freeze vs repair | Unexpected drift is separated from the authorized, finding-bound repair transition; counters not reset. |
| r2-6 | Parity mutation | Artifact finalized in PROVE; reviewer verdict and digest kept in gate state; a clean PASS needs no rewrite. |
| r2-7 | Usage overlap | Sources disjoint by construction, `source_execution_id` dedupe, a budget formula, refresh before each dispatch. |
| r2-8 | Telemetry blocking repair | Repairs authorized from engine state; the run-log check is a fallback; a missing log only degrades telemetry (tested). |

**Round 3 (Codex): NEEDS_CHANGES, then converged.** It confirmed all 8 round-2 fixes are in the text and raised 2 new majors, both accepted as written:

| # | Point | How it was reconciled |
|---|---|---|
| r3-1 | RED runner crash safety | Gate-run commands use the same durable attempt, handshake and quiescence protocol; a crash test with a surviving runner holding a resource. |
| r3-2 | RED bootstrap | A `seams` node creates signature-only stubs before RED, with explicit ownership handover, so RED fails on behavioural assertions rather than imports. |

The debate budget (3 calls) is used up. No disagreement remains.

<!-- RUN-STATE:BEGIN -->
{"event":"START","run_id":"ais-harness2-20261105","approved_plan_digest":"sha256:ec0b2f7e76b4f0bdf0a302649fca7d723b5c4f4db17742dbaf2ae357df4f135b","digest_procedure":"sha256 of the plan file with the text between the RUN-STATE markers removed","approved_via":"ExitPlanMode","approved_at":"2026-11-05T09:30:00Z"}
{"event":"NOTE","run_id":"ais-harness2-20261105","note":"seams: orchestrator wrote signature-only stubs run-engine.mjs and gate.mjs (every export throws not_implemented) before RED, per plan DAG node seams"}
{"event":"RED","run_id":"ais-harness2-20261105","behavioral_failures":{"run-engine.test.mjs":"32/32 fail (31 via not_implemented from the call under test, 1 assertion)","gate.test.mjs":"41/41 fail via not_implemented from the call under test","carrier-usage.test.mjs+usage.test.mjs":"15 new fail on assertions; 31 existing pass"},"import_or_syntax_failures":0}
{"event":"NOTE","run_id":"ais-harness2-20261105","note":"build waves done: carrier+usage, gate+harness (62/62), eval (RED 17 fail -> pass), engine (186/188 suite; 2 timing-flaky specs). Ownership clean on every node."}
{"event":"REPAIR","run_id":"ais-harness2-20261105","phase":"PROVE","batch":1,"node":"integ","scope":["flaky engine specs (shim warm-up)","engine events to <ticket>.engine.jsonl (run-log compat)","canonical review_chain {outcome,findings[{id,severity,paths}],write_set}","config.riskLabels incl. ui","engine RESUME/INFRA_RETRY/ADMISSION_REFUSED events for eval"]}
{"event":"NOTE","run_id":"ais-harness2-20261105","note":"integ: RED 7 fail -> 196/196 twice. docs-ci + bench done: 199/199 twice, validate PASS, all test files in CI matrix. Bench (6-node fixture, measured): manual 30 orchestrator commands / 10272 bytes read / 13608 ms (sequential) vs engine 3 / 739 / 1164 ms (parallel)."}
{"event":"REPAIR","run_id":"ais-harness2-20261105","phase":"PROVE","batch":2,"node":"gatecli","scope":["run-engine gate red|review|ship-ready CLI persisting gate results under the engine lock; SHIP_READY RUN-STATE append; docs lines"],"note":"last PROVE batch allowed by the skill"}
{"event":"REVIEW","run_id":"ais-harness2-20261105","review_execution":"ais2-review-1","candidate_id":"57d8a0879f221b2570a38207488cfe71275dfb781e141ad95ce3ec74e4cc25c1","head":"938eca4","primary":{"reviewer":"opus","outcome":"FAIL","blockers":3,"majors":7,"minors":2,"overflow":true},"second_opinion":{"carrier":"codex","outcome":"FAIL","blockers":8,"majors":4,"overflow":true},"reconciled_unique_findings":17,"theme":"engine CLI wiring: gate commands skip approval checks; completion without quiescence; lock released with live siblings; RED command/resources not bound to DAG; builder roster empty; repair->confirmation unreachable; SHIP_READY ignores node/judgment state; budgets not wired; digest prefix sha256- vs sha256:; plan file excluded from worker snapshots; lock fails open when ps fails","outcome":"FAIL (overflow) - owner decision required"}
{"event":"RETRY","run_id":"ais-harness2-20261105","review_execution":"ais2-review-2","predecessor":"ais2-review-1","authorized_by":"owner (AskUserQuestion, 2026-11-05)","scope":"one REPAIR batch for the 17 reconciled findings in .specs/reviews/AIS-HARNESS-2/HANDOVER.md + one targeted confirmation (Opus primary + Codex); scope, PLAN and review policy unchanged","where":"fresh session"}
{"event":"REPAIR","run_id":"ais-harness2-20261105","review_execution":"ais2-review-2","phase":"REVIEW","batch":1,"node":"ais2-repair","scope":["17 reconciled findings in HANDOVER.md + also-fix items; CLI-path RED tests first (32 CLI + 5 unit + 2 added), Opus builder"],"result":"suite 240/240 twice, validate PASS"}
{"event":"CONFIRM","run_id":"ais-harness2-20261105","review_execution":"ais2-review-2","candidate_id":"7f586fe06f6d546b9bbf728133aee96534290082cad71792d7a8c26a65c7afea","head":"d305763","primary":{"reviewer":"opus","outcome":"FAIL","blockers":0,"majors":3,"minors":4},"second_opinion":{"carrier":"codex","outcome":"FAIL","blockers":4,"not_closed_handover_items":[3,5,7,8,10,11]},"outcome":"FAIL - terminal for this authorized execution; further repair needs a new explicit owner retry; nothing pushed"}
{"event":"RETRY","run_id":"ais-harness2-20261105","review_execution":"ais2-review-3","predecessor":"ais2-review-2","authorized_by":"owner (chat, 2026-11-05: go with option 1)","scope":"one REPAIR batch for ais2-review-2 findings (Opus N3,N4,N5,N6 + Codex blockers 1-4 + handover items 3,5,7,8,10,11 re-verified) + one targeted confirmation (Opus + Codex); N1,N2,N7 ship as follow-ups; scope, PLAN and review policy unchanged"}
{"event":"REPAIR","run_id":"ais-harness2-20261105","review_execution":"ais2-review-3","phase":"REVIEW","batch":1,"node":"ais3-repair","scope":["N3 provider-default builder matches all same-provider reviewers","proof/RED runner quiescence","approval digests rechecked after proof/RED","post-freeze drift blocks review repair","overflow FAIL terminal without RETRY","worker cannot forge RETRY; infra retry keeps round; allSettled test"],"result":"suite 257/257 (one unexplained intermittent failure in 11 runs, not reproduced), validate PASS"}
{"event":"CONFIRM","run_id":"ais-harness2-20261105","review_execution":"ais2-review-3","candidate_id":"10963f5b8154a15db2d4ca79540f0bd61db00f6bfa43d3ef176c0dcd91c07b38","head":"7e90114","primary":{"reviewer":"opus","outcome":"FAIL","blockers":1,"majors":0,"minors":2,"test_gaps":1},"second_opinion":{"carrier":"codex","outcome":"FAIL","blockers":0,"majors":2},"reconciled":"RETRY forgeable by dispatched work (Opus B1 = Codex M2); RED exception path exits without quiescence (Codex M1); minors: binding re-check after RED untested, evidence committed before re-check, flaky test run-engine-review3 line 316","outcome":"FAIL - terminal for this authorized execution; nothing pushed; further repair needs a new explicit owner retry"}
{"event":"RETRY","run_id":"ais-harness2-20261105","review_execution":"ais2-review-4","predecessor":"ais2-review-3","authorized_by":"owner (chat, 2026-11-08: start a new round of review)","scope":"one class-wide REPAIR batch (single quiescence function, single engine-recorded RUN-STATE authorization check, RED exception path, RED binding test, flaky test) + one targeted confirmation (Opus + Codex); N1,N2,N7 remain follow-ups; scope, PLAN and review policy unchanged"}
{"event":"REPAIR","run_id":"ais-harness2-20261105","review_execution":"ais2-review-4","phase":"REVIEW","batch":1,"node":"ais4-repair","scope":["class 1: RUN-STATE authority events trusted only via engine-authority.observeAuthority (single choke point)","class 2: engine-quiesce.retire is the only path to a terminal attempt / lock release","RED exception path, binding re-check before evidence commit, T1 test, deterministic flaky test"],"result":"suite 277/277 x3, validate PASS"}
{"event":"CONFIRM","run_id":"ais-harness2-20261105","review_execution":"ais2-review-4","candidate_id":"149d972be2183085d27df277f359021c6ff59e3379b0436daf38c8a7f8eb2c78","head":"71e3e6e","primary":{"reviewer":"opus","outcome":"FAIL","blockers":0,"majors":1,"minors":1,"informational":1},"second_opinion":{"carrier":"codex","outcome":"PASS","blockers":0,"majors":0,"minors":0},"reconciled":"Opus major B1: a lone CR hides a RETRY line from runStateEvents/workerRunStateAppend (split on \\r?\\n only); visible after any CR-normalizing rewrite; confirmed via CLI probe. Minor m1: node re-dispatchable after mark failed->pending while earlier unknown attempt group is alive. Review-3 items all closed.","outcome":"FAIL - terminal for this authorized execution; nothing pushed; further repair needs a new explicit owner retry"}
{"event":"RETRY","run_id":"ais-harness2-20261105","review_execution":"ais2-review-5","predecessor":"ais2-review-4","authorized_by":"owner (chat, 2026-11-08: go with option A)","scope":"one small REPAIR batch (single RUN-STATE line splitter / reject lone CR and U+2028/2029, unparseable brace-line from a worker = ownership violation, plant-and-normalize test; mark failed->pending must not re-dispatch while an earlier unknown attempt group is alive) + one targeted confirmation (Opus + Codex); N1,N2,N7 remain follow-ups; scope, PLAN and review policy unchanged"}
{"event":"REPAIR","run_id":"ais-harness2-20261105","review_execution":"ais2-review-5","phase":"REVIEW","batch":1,"node":"ais5-repair","scope":["B1 single RUN-STATE splitter (run-state.mjs) + hidden line-break/unparsed brace-line rejection","m1 unknown attempt retired before re-dispatch","m2 legacy_state error"],"result":"suite 289/289 x3, validate PASS"}
{"event":"CONFIRM","run_id":"ais-harness2-20261105","review_execution":"ais2-review-5","candidate_id":"31856a0bbb192b1f0e38774c0979160c4e4603be707b065838c266543defe398","head":"6137c9a","primary":{"reviewer":"opus","outcome":"FAIL","blockers":0,"majors":1,"info":3},"second_opinion":{"carrier":"codex","outcome":"FAIL","blockers":1},"reconciled":"both: duplicate/stray RUN-STATE END marker (run-state.mjs:35) hides a planted RETRY from observeAuthority; removing the marker reveals it as trusted (reproduced by both). review-4 B1, m1, m2 closed.","outcome":"FAIL - terminal for this authorized execution; nothing pushed; further repair needs a new explicit owner retry"}
<!-- RUN-STATE:END -->
