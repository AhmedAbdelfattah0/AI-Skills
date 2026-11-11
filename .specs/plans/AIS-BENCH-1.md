---
ticket: AIS-BENCH-1 (key kept, decision D7; tracked on GitHub issue #51, waves on #52 to #56)
run_id: none (no run started; a run starts only after approval, in a fresh session per wave)
timing_telemetry: not started
native_plan_mode: not used for this draft (assessment session). Each wave plans in native Plan Mode in its own session.
plan_mode_carrier: claude
host_agent: claude (assessment and draft)
counterpart_agent: codex (not consulted for this draft)
plan_debate: {status: NOT RUN for this parent plan; required per wave where section 8 says so}
approval_status: order approved for Waves 0, 1 and 2 on 2026-11-11 (decision D1); Waves 3 and 4 not approved. This parent plan starts no run.
review_profile: per wave (section 8)
source: .specs/reviews/AIS-BENCH-1/assessment.md (pins, evidence, decisions)
open_conflict: engine feature freeze (.specs/plans/AIS-HARNESS-3.md:102) vs Wave 3 — owner decision D2
---

# Plan — AIS-BENCH-1: best-of-both improvements after the agency-agents comparison

Repo: AI-Skills, `main` @ `65b84cd`. Reference: `msitarzewski/agency-agents` @ `8ae6164`.
Shape: skill library and harness tooling (docs + Node helpers, no UI) · security-sensitive:
Wave 3 only (it touches the authorization boundary) · review: per wave.

## 1. What & why

The comparison found that the reference repository is a prompt library with installer tooling
and no runtime, so there is nothing to replace. It gave three things worth adopting (tests for
our installer CLI, a check that cited rule IDs exist, and a set of LLM-application security
checks if you want them) and three worth merging (what a worker brief must contain, criteria
for when a human gate is warranted, and "measure before changing an agent").

Reading our own code for the comparison found more: workers get only a hand-written prompt,
their structured report is ignored by the engine, one extra file mid-run stops everything, and
about 266 KB of `ship-ticket` instructions sit in the orchestrator's context. This plan fixes
the small defects first, then measures, then reduces orchestrator load and standardizes worker
briefs. Engine changes wait for your decision on the feature freeze.

Approving this document approves the roadmap and its order only. Each wave still gets its own
`ship-ticket` plan, in native Plan Mode, with its own approval before any file is changed.

## 2. Assessment summary

Full evidence: `.specs/reviews/AIS-BENCH-1/assessment.md`.

| Decision | Items |
|---|---|
| KEEP | approval and plan binding, DAG scheduling, model tiers, bounded review, recovery, usage accounting, security mechanics, ticket generation, ship-ready gate |
| ADOPT | A1 CLI tests · A2 cited-ID check · A3 LLM-application controls (only on your scope decision) |
| MERGE | M1 generated worker brief · M2 approved expansion envelope · M3 evaluation before a harness change |
| REPLACE | none |
| REJECT | persona roster, seven-phase loop with three retries, reality-checker procedures, MCP memory, format converter, originality and fence lints, metric targets, follow-up lists, UI finish gate, commit regex, state samples |
| VERIFY | Antigravity install path |

## 3. Target architecture

The spine (UNDERSTAND → PLAN → BUILD → PROVE → REVIEW → SHIP), the gates and the approval
boundary stay as they are. Changes are marked with the wave that makes them.

```
approved plan (digest) ──► bound DAG (digest)                          unchanged
      │                         │
      │   optional expansion envelope, inside the approved plan        Wave 3, opt-in
      ▼                         ▼
recon answers ──► brief builder ──► node prompt file (generated, linted)  Wave 2, outside the engine
                                    │
                                    ▼
                         engine drive ──► workers ──► envelope + report   report consumed: Wave 3
                                    │     a node-local stop no longer blocks
                                    │     nodes outside its closure; tree-wide
                                    │     stops stay run-wide                 Wave 3
                                    ▼
                    gates: RED · review · ship-ready                    unchanged, never relaxed
                                    ▼
                    eval report + scenario bench (results checked in)   Wave 1

orchestrator context: spine + per-phase operator cards;                 Wave 2
                      opt-in feature text only when the DAG uses it
library: validator resolves cited IDs; CLI has tests                    Wave 0
```

Design rules:
- No new agent types and no registry. Capabilities stay skills routed by detected stack.
- Every engine addition is an opt-in field. Absent, the state, events and output are
  byte-identical (pinned by the existing golden test).
- No mandatory security or `[NN]` check becomes skippable. Each wave adds a test that the gate
  still refuses.
- Adapted reference material carries its source path, commit and the MIT notice.

## 4. Waves

Each wave is its own branch, pull request and `ship-ticket` run in a fresh session, orchestrated
on Sonnet. Builders are Sonnet unless stated. At most two builders at once. No two workers run
the engine test suite at the same time (issue #49); the suite runs serially at the join.

### Wave 0 — library hygiene (no engine code)

| ID | Owner | Step | Files | Depends on |
|---|---|---|---|---|
| W0-ids | builder A | Validator check: every rule ID cited in a skill, ranges included, exists in the owning skill. Repair the five undefined IDs (`BE-SEC-10`, `BE-AUTH-08`, `BE-AUTH-09`, `BE-VAL-05`, `BE-HDR-06`) per decision D4 | `scripts/cli.mjs`; `skills/nn-guard/**` or `skills/backend-code-quality/SKILL.md`; `AGENTS.md` (invariant list) | D4 |
| W0-cli | builder A | `node:test` suite for the CLI in a temporary home: link and copy install, the three update outcomes, a foreign manifest, each validator check with a planted violation; add to the CI matrix | `scripts/cli.test.mjs` (new); `.github/workflows/validate.yml` | W0-ids (same file owner) |
| W0-restore | builder B | Fix the `session-restore` extraction command with a fixture test that fails on today's text; fix two stale lines | `skills/session-restore/**`; `skills/generate-ticket/references/ticket-template.md`; `skills/self-healing/references/skill-creation-guide.md` | — |
| W0-path | orchestrator | Check the Antigravity path against the primary documentation; record the result; change the path only if it is wrong | `scripts/cli.mjs` (one line and help text) | W0-cli |

### Wave 1 — baseline and scenario bench (measurement before change)

| ID | Owner | Step | Files | Depends on |
|---|---|---|---|---|
| W1-load | orchestrator | Record which references each phase loads and their bytes, for a run with and without units | `.specs/reviews/AIS-BENCH-1/baseline/` (new) | — |
| W1-bench | builder | Extend the fixture bench to the seven scenarios of section 9 with the fake provider; print one JSON result per scenario; check the baseline results in | `skills/ship-ticket/scripts/engine-bench.mjs`, its test, new scenario fixtures | — |

### Wave 2 — orchestrator context and worker briefs (engine untouched)

| ID | Owner | Step | Files | Depends on |
|---|---|---|---|---|
| W2-split | builder, drafted outside the repo and swapped in once | Move opt-in unit text to a reference loaded only when the DAG has unit fields; split `execution-harness.md` into an operator card (commands, inputs, refusals) and a reference (rationale, limits) loaded on demand; update the load table | `skills/ship-ticket/references/execution-harness.md`, `review.md`, `plan.md`, two new references; `SKILL.md` load table; `AGENTS.md` | W1-load |
| W2-brief | builder | `brief.mjs`: build a node's prompt from the DAG node, the approved plan and recon answers (ownership, forbidden paths, required tests, reuse inventory of path + signature, report block); `lint` refuses a brief missing a section; tests | new `skills/ship-ticket/scripts/brief.mjs`, `brief.test.mjs`, `references/brief.md` | — (disjoint from W2-split) |
| W2-join | orchestrator | Link `brief.md` from BUILD; run the validator, the link check and the sentence-preservation check; re-run W1-load and W1-bench | `skills/ship-ticket/SKILL.md` | W2-split, W2-brief |

### Wave 3 — engine changes (blocked until decision D2)

| ID | Owner | Step | Depends on |
|---|---|---|---|
| W3-scope | Opus builder (authorization and state) | Expansion envelope: an approved plan field bound into the DAG config; the engine reads `needs_outside_ownership`; a write inside the envelope is recorded as a scope event and reviewed as a candidate path; outside it, today's `ownership_violation`. The envelope can never cover a risk-labelled node's paths, a contract, a migration, auth or the plan roots | D2, W1-bench |
| W3-isolate | Opus builder, analysis first | Classify every judgment code as tree-wide or node-local. Tree-wide codes stay run-wide, because workers share one work tree and an offending write is not reverted: `ownership_violation`, `ownership_unavailable`, `crash_with_writes`, `quiescence_unknown`, `post_freeze_drift`, the binding mismatches. Only node-local codes (candidates: `red_required`, `red_invalidated`) are scoped to the node's dependency closure. If the list of node-local codes is empty or trivial, this item is dropped and recorded as such. Ship-ready still refuses while any judgment is open | D2, W1-bench |
| W3-evidence | builder | The engine records a worker's reported blockers and tests in `status`; a `shipped` record stores the PR URL, CI conclusion and tracker state as events with no authority. Decide the PROVE repair counter: wire a producer or delete the dead consumer | D2 |
| W3-select | not planned yet | Reuse of unchanged proof after a repair. Build only if W1-bench and one real run show proof reruns are a material share of PROVE time | measurement |

### Wave 4 — your scope decisions

| ID | Step | Depends on |
|---|---|---|
| W4-llm | LLM-application controls in the `vapt` catalogue, then a new pre-registered effectiveness run | D3 |
| W4-a11y | Run `ux-audit`'s automated accessibility lane on owned screens in `ship-ticket`'s UI proof | D5 |
| W4-reuse | A backend "reuse before create" rule ID to match `NG-ARCH-07` | D5 |

**Decomposition:** five waves, each ONE unit (no unit fields) except Wave 3, whose three items
are independent and may be three small tickets. Rationale: Waves 0 to 2 have disjoint files and
no shared contract; Wave 3 items each change the engine's state machine and are reviewed alone.

## 5. Acceptance criteria

| # | Criterion | Wave |
|---|---|---|
| AC1 | The validator fails on a planted undefined rule ID and passes on the repaired tree with 0 undefined citations | 0 |
| AC2 | The documented `session-restore` command returns the latest entry of a two-entry fixture; the test fails on today's text | 0 |
| AC3 | CLI tests cover link and copy install, the three update outcomes, a foreign manifest and each validator check, on the three-system matrix | 0 |
| AC4 | Baseline load sets, byte counts and seven scenario results are checked in before any Wave 2 change | 1 |
| AC5 | A run without unit fields loads none of the opt-in unit text; the byte count per phase is lower than the W1-load baseline by a target fixed in the wave plan; every rule sentence of the old files exists in exactly one new file; validator green | 2 |
| AC6 | `brief.mjs build` is deterministic (same inputs, same digest); `lint` refuses a brief missing ownership, forbidden paths, required tests, reuse inventory or the report block; the engine's golden test is unchanged | 2 |
| AC7 | With an approved envelope, a write inside it is recorded and the node completes; outside it the node fails as today; a protected path is refused at `init`; with no envelope the state is byte-identical | 3 |
| AC8 | A judgment code classified node-local on node A does not block a ready node outside A's closure; every tree-wide code still stops all dispatch (one test per code); ship-ready refuses while any judgment is open | 3 |
| AC9 | After each wave: all existing suites pass when run serially; each new gate path has a mutation test; no gate accepts something it refused before | all |

## 6. Decisions, risks, threshold

**Decisions needed from you**

| # | Decision | Recommendation |
|---|---|---|
| D1 | Approve Waves 0, 1 and 2 | Yes. They contain no engine change |
| D2 | Lift the engine feature freeze for Wave 3, or keep it until the owed unit-arm run exists | Keep it until Wave 1 results exist, then decide per item |
| D3 | Add LLM-application controls to the catalogue | Only if a product of yours has LLM call sites; it restarts the effectiveness measurement |
| D4 | Rule IDs: define the IDs `nn-guard` enforces in `backend-code-quality`, or correct `nn-guard`'s map | Read both and correct whichever is wrong; `BE-SEC-10` (TLS verification disabled) looks like a real rule missing from the backend skill |
| D5 | Wave 4 items W4-a11y and W4-reuse | Defer until a recorded failure asks for them |
| D6 | Does the brief builder count as a harness feature under the freeze | No: it produces a prompt file and the engine is untouched |
| D7 | Key name and whether to commit these two files | Your call; they are untracked |

**Answered on 2026-11-11** (recorded in GitHub issue #51)

| # | Answer |
|---|---|
| D1 | Approved. Waves 0, 1 and 2 ship in order (#52, #53, #54) |
| D4 | Split fix. `BE-SEC-10` `[NN]` is defined in `backend-code-quality`; `nn-guard`'s ranges are shortened to `BE-AUTH-01…07`, `BE-VAL-01…04`, `BE-HDR-01…05` |
| D6 | No. The brief builder is built in Wave 2 |
| D7 | The key stays `AIS-BENCH-1`. This plan and the assessment are committed with the Wave 0 pull request; the evidence folder stays local |
| W0-path | Checked against Antigravity's documentation: the global path is `~/.gemini/config/skills`. The target moves there and `update` keeps refreshing an existing legacy directory |

D2, D3 and D5 are open. Each wave commits its own plan beside this one, starting with
`.specs/plans/AIS-BENCH-1-wave-0.md`.

**Engine work already on record, to rank Wave 3 against (D2)**

| Item | Where it is recorded |
|---|---|
| The unit-arm run on a real ticket; no unit-versus-baseline claim is possible yet | `.specs/reviews/AIS-HARNESS-3/wave4-baseline-scrum307.md`, "Next" |
| A final-review FAIL repair does not clear `post_freeze_drift`; the repair stays blocked behind it | `skills/ship-ticket/references/execution-harness.md:619-620` |
| `rebind` refuses directory-declared nodes, units and changed RED specs | `execution-harness.md:635-644` |
| Over-review cost: a re-checked upstream unit makes every dependent unit's evidence and review stale | `execution-harness.md:581-587` |
| `archive` is run by hand and copies the usage ledger as it stands, so its last line may be partial | `execution-harness.md:621-628` |
| Follow-ups collected on 2026-11-08; some were fixed since, so check each before ranking | `.specs/reviews/AIS-HARNESS-2/PR38-FOLLOWUPS.md`, section 4 |
| Worker worktree isolation deferred; real-ticket savings unmeasured | `execution-harness.md:881-890` |
| Engine suite fails when several copies run at once | issue #49 |
| Selection barely narrows on real code; 14 advisory classes and one finding have no accepted control | `.specs/reviews/AIS-HARNESS-4/closure.md`, "Handed over" |

**Risks**

| Risk | Why it matters | What I'll do |
|---|---|---|
| The doc split drops or duplicates a rule | A lost rule is a silent behaviour change | Sentence-preservation check; grep for what should be gone; one swap, drafted outside the repo |
| A brief builder that is too rigid | Workers lose context a hand-written brief would give | A free-text section stays; lint checks presence, not wording |
| The envelope weakens the approval boundary | It is the authorization rule | Opt-in, inside the approved plan digest, protected paths refused at `init`, Opus builder, elevated review |
| Scenario bench is read as proof of quality | It uses a fake provider | Every result is labelled mechanism-only |
| Parallel suite runs | Issue #49 gives false failures | One suite at a time, at the join |
| Runs starting on or after 2026-11-12 | `init` refuses without `securityPolicy: 2` and plan section 3a | Each wave plan carries 3a (three lines when nothing is selected) |

**Ship threshold:** default. Display-only or cosmetic findings of medium severity or lower ship
with a follow-up; anything touching data integrity, security, tenancy or money blocks.

### 3a. Security risk assessment

Not applicable to this parent plan: it starts no run. Each wave plan carries its own section 3a.
Waves 0 to 2 expect the compact form (no security-relevant surface). Wave 3 changes gate and
authorization logic and is ELEVATED.

## 7. Cross-model planning debate

**Result:** NOT RUN for this parent plan. No Codex session was started. Wave plans follow the
rule in section 8. Model agreement is advice, not approval.

## 8. Proof and review routing

| Wave | Profile | Plan debate | Primary review | Second opinion |
|---|---|---|---|---|
| 0 | STANDARD | skipped, recorded (low risk) | Opus | Codex (CodeRabbit fallback) |
| 1 | STANDARD | skipped, recorded | Opus | Codex (CodeRabbit fallback) |
| 2 | ELEVATED (public skill contract) | skipped, recorded | Opus | Codex (CodeRabbit fallback) |
| 3 | ELEVATED (authorization, state) | required | Opus | Codex before the Opus confirmation of any repair |

Parity: not triggered (no UI). Attack inventory: not triggered for Waves 0 to 2; Wave 3 states
its own.

## 9. Evaluation strategy

**Deterministic scenario bench (Wave 1).** Fake provider, as `engine-bench.mjs` does today. It
shows mechanism and orchestration overhead only.

| # | Scenario | What it must show |
|---|---|---|
| S1 | Simple frontend change, one node | the smallest run completes with the fewest orchestrator commands |
| S2 | Full-stack: contract, then frontend and backend together, then join | both sides dispatch in one wave |
| S3 | Auth-sensitive change | ship-ready refuses without accepted RED and the required evidence |
| S4 | Six nodes in two waves and a join | parallel dispatch and peak concurrency |
| S5 | Failure and recovery: provider error, timeout, engine crash, worker crash with writes | one retry, no retry, resume without a second writer, a judgment |
| S6 | Scope expansion: a worker writes one extra file | today: violation and a full stop. After Wave 3: recorded inside an envelope, refused outside |
| S7 | UI change | ship-ready refuses without the parity evidence |

Metrics per scenario: orchestrator commands, bytes the orchestrator reads, wall time, nodes
completed, judgments raised, owner interventions needed to finish, proof command executions,
retries.

**Real tickets.** From your own ticket pool, when you next run them. Read from
`eval.mjs report`: tokens by role and phase, orchestrator share, wall time by phase, review
executions and repairs, findings by severity, resumes, infra retries. Recorded by hand: owner
stops, and defects found within 14 days. First-pass completion means the final review passed on
its first execution with no repair. Run `archive` before removing a worktree. With one or two
runs per arm these are observations, not proof of a difference.

**Existing baseline.** SCRUM-307, one ticket, one arm, not a clean engine-gated run: about 183M
tokens, orchestrator 93.4M, 3 h 42 min to ship-ready, two review executions.

**Rejection rule.** A change that lowers cost and lets any scenario's mandatory gate pass where
it refused before is rejected.

## 10. Migration and rollback

- One pull request per wave; revert the pull request to roll back.
- Installed skills are links into `~/.ai-skills`: after a merge, `git -C ~/.ai-skills pull
  --ff-only`. Nothing here adds a skill, so no reinstall is needed.
- Wave 2 moves text between references. Readers of the old file names: the `SKILL.md` load
  table and `AGENTS.md`; both change in the same pull request. No concept is deleted, so the
  retired-vocabulary table gains nothing.
- Wave 3 fields are opt-in. A plan written before Wave 3 runs unchanged.
- Running tickets: a run in flight keeps the engine it started with until its worktree is
  archived.

## 11. Expected impact

Nothing below is measured except the counts marked "today".

| Wave | Quality and reliability | Time | Tokens | How it will be checked |
|---|---|---|---|---|
| 0 | Five undefined rule IDs and one broken command fixed (today: 5 and 1); CLI regressions caught in CI | none | none | AC1 to AC3 |
| 1 | none | none | none | results exist (AC4) |
| 2 | Fewer review repairs from thin briefs (expected) | Less worker exploration (expected) | Lower fixed orchestrator context; at least the 25 KB of unit text for runs without units (today: 266 KB total). Effect on total tokens unknown | AC5, AC6; `review_repairs` and orchestrator share on real runs |
| 3 | Fewer full stops overnight (expected); completion evidence recorded | Fewer waits for the owner (expected) | none expected | S5, S6; owner stops per real run |
| 4 | Depends on your scope decisions | — | — | per item |

## 12. Not in this plan

- Any persona agent, roster or registry.
- Worktree isolation for workers, Windows engine support, cross-run locks (documented limits).
- The unit-arm run on a real ticket (owed under AIS-HARNESS-3; it needs one of your tickets).
- Any change to the vendored `security-audit` skill.

## Verification

Per wave: `node scripts/cli.mjs validate`; the wave's own tests; the harness suites run
serially; the scenario bench before and after; a grep for every phrase the wave replaced.

<!-- RUN-STATE:BEGIN -->
<!-- Append one compact JSON object per execution event; never edit or reorder
     an existing entry. No START exists: this parent plan starts no run. Each wave plan
     (`AIS-BENCH-1-wave-<n>.md`) carries its own START. -->
<!-- RUN-STATE:END -->
