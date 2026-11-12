---
ticket: AIS-BENCH-1 Wave 3a W3-record (GitHub issue #55 item W3-record; tracking issue #51)
branch: feat/AIS-BENCH-1-w3-record
run_id: w3a-20261112-050821
host_agent: claude
counterpart_agent: codex (CodeRabbit fallback)
plan_debate: {status: DONE, reason: "required by #55 routing for engine items; Opus design note plus Codex critique, 9 findings folded in"}
approval_status: approved
approved_via: ExitPlanMode on 2026-11-12 (owner asleep; delegated recommended-option approvals)
review_profile: ELEVATED
review_profile_reasons: ["engine state machine and review record"]
base: main@888df9e
execution: manual flow with Agent dispatch (engine helpers not used, declared degradation as in earlier waves)
candidate_exclusions: [".claude", ".specs/reviews/AIS-BENCH-1/evidence", "session-log.md"]
---


Branch `feat/AIS-BENCH-1-w3-record` from `main` · plan file `.specs/plans/AIS-BENCH-1-w3-record.md` · tracker: #55 (W3-record), #51 · D2 narrow lift recorded on #51 (2026-11-11) · Sonnet orchestrator via `/ship-ticket`.

**Shape:** engine state/record change plus tests, bench rows and docs (no FE/BE) · security-sensitive: yes in the sense that it touches the review record and the authority readers; no new authority path · review: **ELEVATED** (engine state machine) · plan debate: **done** (Opus design note + Codex critique, 9 findings folded in below; verdict was STOP on one finding, now resolved by normalizing instead of rejecting).

## 1. What & why

The review record stores only the primary reviewer's outcome (`gate.mjs:461-462`), refused gate lines carry no reasons, unit or time, and state events have no timestamps (gaps G1, G7 in `.specs/reviews/AIS-BENCH-1/gap-analysis-closure.md`). This wave makes the engine record more, **adding fields only**: no gate decision, authority, candidate id or digest-of-inputs changes, and with the switch absent every byte of every record, event and log line stays as it is today.

**Hard rule (STOP condition):** nothing may change what a gate accepts or refuses. In particular the refusal of "primary PASS plus a second-opinion finding disposed `fix`" (`outcome_inconsistent`, `gate.mjs:449-451`) **stays**: recording a reconciled FAIL beside the primary's PASS would turn a refusal into an accepted record that authorizes a repair write set (`carrier.mjs:151-157`, `engine-gates.mjs:217-221`). If any step needs to change a decision, stop and report.

## 2. Design (what changes)

One opt-in switch: `config.auditRecord` (boolean, never defaulted), added to `CONFIG_FIELDS`/`validateEngineDag` in `engine-dag.mjs` next to `unitReview`; helper `auditOn(S)`. Everything below is guarded by it and appended with a conditional spread.

| ID | Change | Files |
|---|---|---|
| A1 | Original review records (final and unit) also store `primary_outcome`, `second_opinion_outcome`, `second_opinion_identity`, `reconciliation` (short text). `outcome` keeps its meaning. Values stay inside the existing PASS/FAIL set; no new vocabulary (`OUTCOME_VOCABULARY` keeps its one owner). | `gate.mjs` (record build near 461-462), `engine-gates.mjs:194-195`, `engine-unit-review.mjs:165` (set the engine-only policy key `recordVerdicts`) |
| A2 | `reconciliation.summary` is **normalized at the recording boundary, never rejected**: non-string becomes null, longer than 2000 characters is truncated. The gate result is unchanged for any input (a review with `summary: 42`, `null` or 2001 characters is accepted today and stays accepted). Same bounding inside `gateReview` itself so direct calls cannot bypass the cap. | `gate.mjs` |
| A3 | Confirmations pass a **separate recording-policy argument** (not the policy object in the second-opinion parameter): `confirm()` gets `primary_outcome` under the switch; a primary-PASS / second-FAIL confirmation yields FAIL (`gate.mjs:512`), so the doc claim "the record's outcome is the primary's" is limited to original reviews. | `gate.mjs:405,481,512` |
| A4 | Refused and accepted GATE lines (state event and engine log, `run-engine.mjs:505-507`) gain `reasons` (≤20 entries × 500 chars), `unit`, `review_execution`, and the submitted `primary_outcome`/`second_opinion_outcome`. Each field is built explicitly and accepted only if it is a bounded string, otherwise omitted; inputs, `v.reasons` and verdicts are not mutated. | `run-engine.mjs` |
| A5 | **Snapshot timestamps**: a pure `stampAudit` called in `E.commit()` gives each new event `at` and each terminal attempt `ended_at` (abandoned, timed-out, crashed handled; live attempts never stamped). Documented as snapshot-preparation time, not decision time (stamped before `structuredClone`, queueing and the atomic write); a failed write leaves the next commit to stamp. A per-command memo prevents restamping (gateRed's private clone). Test clock `ctx.now` is added to `CTX_KEYS` for in-process tests only; the CLI never sets it; existing wall-clock timestamps (GATE `timestamp`) stay as they are and tests scope deterministic assertions to the new fields. | `run-engine.mjs` (`CTX_KEYS`, `commit`), `engine-io.mjs` only if needed |
| A6 | Docs: `harness-internals.md` (record shape, switch, untrusted-text label, snapshot timestamp semantics, old records stay valid), `review.md`/plan template note that new runs may set `auditRecord: true` (docs only, no default change). | `references/harness-internals.md`, `references/plan.md` or `execution-harness.md` pointer |
| A7 | Bench: `builtWorld` forwards config (empty default), S8 keeps its four baseline rows and adds rows from a run with `auditRecord: true`, `reader_can_reconstruct` derived from fields actually recorded, persisted config asserted true. | `engine-bench-scenarios.mjs`, `engine-bench.test.mjs`, `.specs/reviews/AIS-BENCH-1/w3-record/` |

Not changed: candidate id, RUN-STATE delivery, authority, plan/DAG digest of unchanged inputs, `gateShipReady`/repair/carrier/confirm decisions. Binding-drift refusal (`run-engine.mjs:492`) is **not** recorded (its `run_mismatch` path would write into another run's record). Digest wording (Codex 6): adding `auditRecord` changes the DAG bytes and so the DAG/plan digest by design (approved config binding); archive checksums of state/log files change when the switch is on; unchanged inputs give unchanged digests and candidate ids, asserted for equal inputs.

## 3. Execution (DAG)

| Step | Owner | Depends on |
|---|---|---|
| a: A1-A3 (gate.mjs, engine-gates, engine-unit-review) + tests | builder A (opus, ELEVATED strong tier) | — |
| b: A4-A5 (run-engine.mjs, engine-dag.mjs config field) + tests | builder B (opus) | a (shared record shapes; same module family) |
| c: new `run-engine-record.test.mjs` ([R1]-[R9] tags, exact bracket tags), `engine-record-mutation.test.mjs` (mechanism copied from `engine-security-mutation`), `gate.test.mjs` "PASS with findings to fix" test, CLI-level test | builder B | a, b |
| d: A6 docs, A7 bench | builder C (sonnet) | b |
| join: AGENTS.md, validate.yml (new test files), load re-measure, validator, suites one at a time, two sequential four-copy rounds | orchestrator | all |

Max 2 agents at once. Builders never run git index commands; `validate.yml`, `AGENTS.md` only by the orchestrator.

## 4. Tests (all must fail for the right reason first)

- [R1] switch absent AND explicit `false`: exact normalized baseline structures, values and key order unchanged for original, unit, confirmation (with second opinion) and telemetry-failure records (assert absence only for fields that are genuinely new; Codex 5).
- [R2] switch on: each reviewer's verdict and reconciliation recoverable from the record; summary normalization table (non-string, null, 2001 chars) gives identical gate results with switch on and off.
- [R3] primary PASS + second FAIL confirmation (final and unit): outcome FAIL, `primary_outcome` PASS recorded; mutant: reconciled-outcome substitution must be killed.
- [R4] gate line carries reasons/unit/review_execution; oversize and wrong-type subjects, reasons and summary are bounded or omitted; terminal attempt kinds (abandoned, timed-out, crashed) stamped, live never.
- [R5] timestamps: restart preservation, queued commits, write failure, no restamp across commands, `ctx.now` accepted by every command that takes context.
- [R6] the refusal stays: "primary PASS with findings to fix" refused at function and CLI level; mutant on `|| fixes.length` killed.
- [R7] differential run switch off vs on: gate decisions, authority, repair write sets, ship-ready results, candidate id identical; contradictory-metadata positive/negative per authority reader (carrier, repair authorization, ship-ready, unit `reviewStates`).
- [R8] untrusted text: quotes, newlines, U+2028/2029, terminal escapes, fake START/RETRY/SHIP_READY payloads in summary/reasons round-trip as JSON and are never promoted to authority; documented as untrusted diagnostic content.
- [R9] golden `run-engine-units.golden.json` byte-identical.
- Mutants (one per tag): `auditOn` forced true, readers adopting audit fields, dropping confirmation policy forwarding, restamping across commands, stamping live attempts, reconciled-outcome substitution, `|| fixes.length` removed.

## 5. Risks

| Risk | Handling |
|---|---|
| A gate decision changes by accident | R6, R7, R9 and the differential run; STOP rule; Codex plan finding 1 resolved by normalizing, not rejecting |
| Record readers break on new keys | readers select named fields (checked in the design note); old records stay valid; R1 exact baselines |
| Free text (`summary`, `reasons`) treated as authority or rendered unsafely | caps, explicit builds, R8, labeled untrusted in docs |
| Timestamps nondeterministic | `ctx.now` for in-process tests; deterministic assertions only on new fields |
| Engine suites flake under load | one suite at a time, nothing else running; two sequential four-copy rounds on an idle machine |
| Public contract / byte budget | docs only on-demand reference text; card `execution-harness.md` unchanged at 40,914; no-unit total ≤ 220,000 |

Security assessment: the review record and the authority readers are touched (no new authority path); `security-plan.mjs select` output goes into the persisted plan.

## 6. Verification

- Validator exits 0; all suites serially (harness incl. new files, properties, security mutation, new record mutation test); golden unchanged; S1-S8 baseline rows unchanged, new S8 rows recorded.
- Two sequential rounds of four concurrent copies of the harness suite on an idle machine; report exact results (this machine's known S1 flake family noted, not hidden).
- Review: ELEVATED: Opus primary + Codex second opinion (CodeRabbit fallback); repair gets the Codex check before the Opus confirmation; one repair batch, one confirmation; PR "Refs #55" (W3-record ticked, #55 stays open for the rest); the user merges.

## 7. Out of scope

W3-rebase, W3-exception, W3-red, W3-guards, W3-scope, W3-isolate, W3-evidence, P1-P4; any change to a gate decision, authority, candidate id or plan-digest procedure; recording the binding-drift refusal; making `auditRecord` default on.

## Review outcome (recorded at SHIP)

- Plan debate: Opus design note plus Codex critique (STOP on one finding: rejecting a bad `reconciliation.summary` would change a gate decision; resolved by normalizing). Build: builder A (gate/records), builder B (gate lines, timestamps, tests, mutation harness), builder C (docs, bench).
- Review: Opus PASS (6 minor); Codex 4 findings (line separators in log rows, mutation harness counting infra failures as kills, failed-write comment, digest normalization). One repair batch fixed all; the Codex check of the repair found one remaining (infra classification), closed inside the same batch; confirmation: Opus PASS. Nothing changes a gate decision, authority, candidate id or digest of unchanged inputs.
- Proof on the final tree: serial harness 657/657, properties 2/2, security mutation 1/1, record mutation 3/3 (30 mutants killed, none inconclusive); validator exits 0; no-unit load 208,863 bytes.
- Four concurrent copies: on this branch (cut from main without the #64 test fixes) round B before the repair showed only the two tests #64 fixes. After the repair, a final round ran while the machine was heavily loaded by other work (load average 10 to 23, Spotlight and other apps): all bench scenario tests failed with the known first-run stall (`billing_unverified`, S1 `judgment`, node `a` pending). That is the environment family tracked in #49, not a W3-record result; the rerun on a quiet machine is reported on the PR.
- Cosmetic nits shipped as follow-ups: the CI comment says 143 s where the record mutation step took 188 s; one docs line says 'log rows' where only GATE rows are escaped.
