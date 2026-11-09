---
ticket: AIS-HARNESS-4 (local key; AI-Skills has no tracker — degradation recorded)
run_id: wf-1794208398
timing_telemetry: active
native_plan_mode: active
plan_mode_carrier: claude
host_agent: claude (sonnet orchestrator; opus design reviewer)
counterpart_agent: codex (cli 0.166.0, read-only)
plan_debate: {max_calls: 3, total_timeout: 20m, status: CONVERGED on v2.1, round 3 AGREE}
approval_status: approved
review_profile: ELEVATED
review_profile_reasons: [security-gate logic, shared contracts (gate/state/review schema), public skill contracts]
review_route: {primary: opus, second_opinion: codex (CodeRabbit fallback)}
branch_per_wave: {A: feat/AIS-HARNESS-4-wave-a-catalog}
open_conflict: AIS-HARNESS-3 "feature freeze: no new engine/unit features until Wave 4 evidence exists" (.specs/plans/AIS-HARNESS-3.md:102) vs Wave B engine changes — owner decision required before Wave B
---

# Plan — AIS-HARNESS-4 (v2): Risk-adaptive security planning and verification for ship-ticket

Repo: AI-Skills, `main` @ a8ef559. No tracker ticket; the pasted spec is the specification, so the acceptance criteria below are derived for you to approve. Shape: harness tooling (docs + Node helpers, no UI) · security-sensitive: yes (it governs security gates) · review: ELEVATED.

## 1. What & why
Today ship-ticket already attacks every trust boundary a diff touches. What is missing: the security decisions are not in the plan you approve, the attack catalog (`VAPT-*`, 17 OWASP-API-style classes) misses most of the business-abuse classes the StoreCraft audit found, the plan is never compared with the real diff on security signals, and nothing measures whether it works. This adds, by extending existing mechanisms: a security assessment in the approved plan, a versioned control catalog, a diff-vs-plan reassessment, review coverage of the selection, and a measured offline regression suite.

## 2. Phase 1 assessment
**Reuse (verified against code by the Opus design review)**
| Need | Existing mechanism |
|---|---|
| fail-closed evidence per risk | `harness.mjs` `RISK_EVIDENCE` (`:127`) → `gate ship-ready` requires accepted RED + green local proof for `*-spec` kinds (`gate.mjs:486-492`) |
| plan/DAG integrity | `approved_plan_digest`, `DAG_BOUND`, `dag_mismatch` (`run-engine.mjs:138`) |
| authority events | `AUTHORITY_EVENTS` (`run-state.mjs:15`), forged-event check (`engine-gates.mjs:168`) |
| per-item review coverage | primary `rule_rows` + `finalReviewRefusal` coverage pattern (`engine-gates.mjs:43-52`) |
| diff-based PROVE | `prove.md` stages 2/4 already recompute inventory from the changed tree |
| attacks | `vapt` GATE mode, `[NN]/[D]` tiers; static `BE-*` ↔ runtime `VAPT-*` split (AGENTS.md:227-246) |
| Cloudflare audit skill | `skills/security-audit` is vendored and auto-synced: never edited; stays the independent audit layer |

**Gaps (corrected)**
1. The spec's "universal checklist" premise only partly holds: coverage is already boundary-driven.
2. The plan has no security section; you approve boundaries, not controls, evidence or blocking policy.
3. Catalog coverage. Preliminary hand-mapping of the 24 confirmed findings: most are business-logic abuse of the anonymous surface (unproven email as identity F03/F13/F15; unsolicited outbound mail F02/F04/F07/F19; stock holds F05/F08; wallet/quota F09/F22; state invariants F06/F12/F24; entitlements F14; link host F23). About half match no `VAPT` class; the rest only loosely (API-04/05/08). **Hypothesis** until a second independent mapper confirms it in Wave A. Custom-domain tenant binding is a *lead* (needs validation), not a confirmed finding. F01 and F14 were reproduced only on mocks.
4. Four overlapping classifiers decide risk/security-relevance: SKILL.md "Security sensitivity", the ELEVATED list, harness `HIGH_RISK`, and `CONFIRM_SECOND_OPINION` (`engine-gates.mjs:140`). Only security *applicability* moves to the catalog; concurrency/migration/schema/UI labels and ELEVATED rules stay, with an explicit mapping.
5. PROVE recomputes boundaries from the diff, but never compares them with the approved plan, and its signals omit outbound side effects, identity proofs and money/stock/quota effects, the very families in gap 3.
6. A skipped test counts as proof today (local proof stores exit codes only, `engine-gates.mjs:234`).
7. Reviewers check rules and attacks, not whether control *selection* and *exclusions* were right.
8. No effectiveness measurement.

## 3. Design (minimal)
**Catalog** — `skills/vapt/controls.json` (versioned, digest recorded) owned by `vapt`; drift check between it and the `SKILL.md` table lives in a vapt test/validator check (not `validate.sh`). Fields: `id`, category, `applies_when` (structured predicates), prevention, `verify {type: static|runtime|both, pattern}`, tier `[NN]`/`[D]` (reuse vapt tiers, no new `block/warn`), required evidence, `sources` (class/fingerprint only, no copied recommendations), `validated` note. New `VAPT-ABUSE-*` classes (unproven identity as authority, outbound message abuse, resource holds/quota, state invariants, entitlement enforcement, link-host trust). **Every ABUSE control carries a deterministic test pattern**; judgment-only items go to the review checklist instead. AGENTS.md is updated to say ABUSE classes have no static `BE-*` mirror (or gets BE counterparts). Leads (e.g. NV07 Paymob) are not controls until validated. If the catalog is missing, `select` refuses → WAIT_FOR_USER (never an empty selection); ship-ticket carries a fallback summary per AGENTS.md:187-194.

**Selection (facts, not keywords)** — planner writes `security_facts`: the complete changed-surface inventory (same inventory PROVE builds) with principals reaching each surface (incl. anonymous), persistent writes, outbound side effects, identity proofs relied on, money/stock/quota effects, deps, infra; each fact cites a path; unknowns explicit. `scripts/security-plan.mjs select` maps facts → controls deterministically; unknown ⇒ control stays selected. A control whose predicates are true/unknown cannot be excluded by a written reason alone; it needs a waiver. Output prints only selected controls (low token cost).

**Plan section 3a "Security risk assessment"** (inside the approved digest): per risk — why it applies · controls · verification · success evidence · blocks execution/delivery; baseline line; excluded controls with evidence. Trivial ticket: one line "no security-relevant surface: <evidence>", checked against reassess signals. The section is **required** when the plan is ELEVATED/security-sensitive, `riskLabels` is non-empty, or vapt's trigger fires.

**Binding and execution** — each selected control is a `RISK_EVIDENCE` entry with `*-spec` kinds (reuses the existing fail-closed path: accepted RED, then the *named spec shows `pass`, not `skip`* in parsed local-proof output). The control's test sits in an existing node whose paths the Design Contract already covers; a path outside it is contract expansion → WAIT_FOR_USER. `select` emits both the §3a rows and the config IDs; `init` refuses when the IDs in the DAG differ from the approved narrative. No agent-written PASS: the engine derives control status from spec results bound to the candidate. Per-boundary coverage is `(boundary_id, control_id)` using PROVE's canonical boundary record, checked through primary `rule_rows` (`subject_id` = control ID). Test-first and review are unchanged.

**Reassessment** — `security-plan.mjs reassess` compares the diff-derived inventory (canonical candidate inventory, not a second enumerator) with the approved §3a rows. Signals: out-of-plan paths, new/changed routes and unauthenticated handlers, auth/middleware/RLS/migrations, new or bumped dependencies/lockfile, env/secret refs, infra/CI config, plus calls to mail/notification senders, payment, stock and wallet RPCs. Unclassified signals go to the LLM; a missing classification refuses. Runs on every engine run (no-op when no signals), again after any PROVE or REVIEW repair touching mapped files, and must be fresh before REVIEW and ship-ready. Outcomes: `UNCHANGED` · `ADD_CONTROLS` (inside contract) · `REAPPROVAL`. `ADD_CONTROLS` is an add-only authority event `SECURITY_ADDENDUM` the gate unions in; removal is impossible; tested for resume and interruption. `REAPPROVAL` = new START + plan digest, WAIT_FOR_USER.

**Fail-closed** — no new vocabulary: `PASS / FAIL / DEGRADED / NOT_APPLICABLE` (evidence-backed). No PASS evidence ⇒ missing ⇒ refused (no `UNVERIFIED`). A selected `[NN]` control that is DEGRADED blocks ship-ready unless waived (see decision 3). Waiver = authority event `SECURITY_WAIVER {control, boundary, candidate, policy_version, authorized_by, reason}`; appended while work is live ⇒ refused; `NOT_APPLICABLE` is separate, not a waiver. Without Node, the helpers are a declared degradation and the plan says so (SKILL.md:108).

**Independent verification** — no new review field. Selection and exclusion adequacy fold into the existing `security_outcome`; per-control `rule_rows` give coverage. The opposite-model opinion gets a security-plan prompt and returns findings only (it never approves, review.md:207). The implementer never self-certifies. Cloudflare/VPT audits remain separate layers; their findings enter the catalog only by explicit PR.

**Round-2 tightenings (v2.1)** [Codex]
- *Admission* (R1): `init` of any **new** run requires `security_policy: 2`; omission is refused. Only runs already `DAG_BOUND` and approved before Wave B merges are grandfathered, identified by their existing bound state, never by a missing field.
- *Pairwise coverage* (R3): each selected `(boundary_id, control_id)` pair maps to named specs in a machine-checked table (`control_coverage`); the gate requires every pair to have its own accepted RED and passing named spec, and the primary `rule_rows` to carry one PASS row per pair (`subject_id = <boundary>:<control>`). A pass on one boundary never discharges another. `boundRiskEvidence`'s file-only RED matching is extended for these kinds.
- *Freshness* (R6): reassessment and review coverage are bound to `candidate_id + approved_plan_digest + catalog_digest + effective_addendum_set`. A `SECURITY_ADDENDUM` or catalog change invalidates an accepted review and requires updated independent coverage before ship-ready, even when candidate bytes are unchanged.
- *Typed verification* (R7): every control, static or runtime, must discharge through an executable named spec that is RED then green (static controls use executable static assertions, e.g. an AST/config check test). `verify.type` records which kind of proof the spec supplies; it is never a way to skip the spec. Runtime/both controls additionally require the vapt disposable-target run.
- *No inapplicability escape* (new finding): under policy 2 the gate rejects `NOT_APPLICABLE` rows for selected controls whose predicates are true/unknown unless backed by a `SECURITY_WAIVER`, and rejects `security_outcome: NOT_TRIGGERED` whenever effective controls exist; every selected, unwaived pair needs a PASS row.
- *Evaluation honesty* (R11): per-family results are labelled **retrospective family coverage on development data**, not generalization; each fold's catalog build excludes the held-out family where feasible. Generalization is claimed only from the non-StoreCraft sealed corpus.

**Compatibility** — `security_policy: 2` pinned at `DAG_BOUND`. Pre-existing bound runs are grandfathered and byte-identical (golden test); new-policy runs must carry the assessment (an evidenced empty one is valid). Narrowed AC: no new required artifacts when reassess finds no signals. New config keys are added to `CONFIG_FIELDS` and not defaulted (follow `unitReview`, `engine-dag.mjs:109`) so existing DAG bytes don't change. `SECURITY_ADDENDUM`, `SECURITY_WAIVER`, `SECURITY_REASSESSED` are added to the closed event list in `ship.md`.

## 4. Waves (each its own branch, PR, bounded review)
**A — Catalog.** `skills/vapt/{SKILL.md,controls.json}` + drift test, AGENTS.md invariant text, independent second-mapper validation of the hand-mapping, per-control validation notes.
**B — Plan, gate, reassess, review.** New `references/security-risk.md` (linked from the spine; AGENTS.md:259 list), edits to `plan.md`, `prove.md`, `review.md`, `ship.md`; spine +few lines; `scripts/security-plan.mjs` + test; additive changes in `harness.mjs`, `engine-dag.mjs`, `engine-gates.mjs`, `gate.mjs`, `run-state.mjs`; `.github/workflows/validate.yml` test list. Gate/state edits go to an `opus` builder.
**C — Regression and effectiveness.** (1) *Selector correctness*, deterministic in CI: fixtures with independently labelled expected controls and negative (non-security) cases; says plainly it measures mapping from facts. (2) *Effectiveness*: StoreCraft is development data. Catalog frozen (digest) before scoring; leave-one-family-out splits over ~6 families, per-family counts, not percentages; an agent that has not seen the catalog writes the facts from ticket text + pre-fix code and fact extraction is scored separately; at least one non-StoreCraft corpus (VPT history, seeded fixtures); no tuning on held-out failures. Optional LLM before/after on ≤3 tasks, cost-capped, on your say-so. Report claims only what was measured.

## 5. Acceptance criteria
- AC1 `controls.json` validates and matches the `vapt` table; vendored `security-audit` unchanged.
- AC2 `select` meets expected sets on all fixtures, unknown facts keep controls, no keyword-only rule.
- AC3 Grandfathered runs byte-identical; no new artifacts when reassess finds no signals; existing suites green; validator passes.
- AC4 `gate ship-ready` refuses a selected control without accepted RED + passing named spec (a `skip`, placeholder file or stale candidate fails); waiver forged while live is refused.
- AC5 `reassess` flags in fixtures: out-of-plan path, new dependency, auth/migration change, new route, new mail/payment/stock call; `REAPPROVAL` never continues; `ADD_CONTROLS` is add-only across resume.
- AC6 Review refuses a primary missing a control `rule_row`; counterpart output stays findings-only.
- AC7 Wave C report with pre-registered metrics, per-family hold-out results, limitations named.
- AC8 Small-fix path adds ≤1 plan line and no extra agent; helper overhead measured.

## 6. Risks, decisions, threshold
Decisions for you (approving this plan accepts the recommended default):
1. Catalog home: **`vapt`** (rec) vs ship-ticket.
2. **Three PRs** A→B→C (rec) vs one PR.
3. Under policy 2, a selected `[NN]` control that is DEGRADED **blocks** ship-ready unless you waive it (rec). This is stricter than today, where missing principals ship as DEGRADED.
4. Optional LLM-level before/after run in Wave C: **decide at Wave C**, default off.
5. In-flight approved plans grandfathered (rec).
Risks: catalog derived from one product's audit (mitigated by family hold-out + a second corpus); small sample (~24); more instructions raise review noise (one new reference only). Ship threshold: wording/cosmetic doc issues ship with a follow-up; anything weakening a gate, fail-closed logic, binding or authority events blocks. Out of scope: running the Cloudflare audit per ticket, editing the vendored skill, StoreCraft code, CI enforcement in other repos.

## 7. Cross-model planning debate
Participants: Claude host (Sonnet orchestrator + Opus design reviewer) ↔ Codex CLI 0.166.0, read-only. Round 1 on v1: Codex 11 findings (CHANGES_REQUESTED), Opus 12 findings (3 blockers). All incorporated or answered in v2 (R1 policy pinning, R2 facts, R3 boundary coverage, R4 derived results, R5 addendum, R6 freshness, R7 typed verify, R8 waivers, R9 security-only consolidation, R10/R11 evaluation; Opus 1-3 spec kinds / required section / binding, 5 no new review field, 7 vocabulary, 8-9 ABUSE tests and catalog fallback, 10 family splits, 11-12 corrections and CI plumbing). Round 2 (Codex on v2): R2, R4, R5, R8, R9, R10 conceded; R1, R3, R6, R7, R11 still open plus one new finding (NOT_APPLICABLE escape) — all addressed in v2.1 above. Calls used: 2 of 3. Round 3 (Codex on v2.1): **AGREE**, all open items conceded, no new blockers. Status: CONVERGED on v2.1 (3 of 3 calls used). Model agreement is advice, not approval.

## 8. Proof and review routing
Builders `sonnet`, gate/state logic `opus`; primary review `opus` (security-gate design) plus mandatory Codex second opinion (CodeRabbit fallback); ≤3 agents concurrent; per wave `node --test` on touched scripts, `cli.mjs validate`, golden test.

## Verification
`cd skills/ship-ticket/scripts && node --test`; `node scripts/cli.mjs validate`; `security-plan.mjs select|reassess` on fixtures; Wave C eval report vs pre-registered thresholds.

<!-- RUN-STATE:BEGIN -->
{"event":"START","run_id":"wf-1794208398","approved_plan_digest":"sha256:84c64a3f815d979d4959e21fb56a9776cd6c0c756e99d9f8d957af1ed8415ba1","digest_procedure":"sha256 of the plan file with the text between the RUN-STATE markers removed (markers kept adjacent)","approved_via":"ExitPlanMode","approved_at":"2026-11-09T07:30:16.048Z","base":"main@a8ef559","scope":"Wave A only; Waves B/C need their own branch and the freeze conflict resolved"}
{"event":"REVIEW","run_id":"wf-1794208398","review_execution":"ais4a-review-1","wave":"A","profile":"ELEVATED","candidate_id":"12c1e40b6b5c677e8e000aba6fa892e6e0b6d9922c519f1e05524fd3b1f96920","primary":"opus","second_opinion":"codex 0.166.0","outcome":"FAIL","findings":{"blocker":2,"major":6,"minor":3,"codex":9},"note":"false not-applicable predicates on [NN] controls; weak drift test; overstated validated notes"}
{"event":"REPAIR","run_id":"wf-1794208398","review_execution":"ais4a-review-1","phase":"REVIEW","batch":1,"node":"wave-a-repair","candidate_id":"d8ad927ecbae0d9fd4a1bbcc23873a75e1db57fbd80c8e7b6a34a5778d92a031","rerun":["node --test skills/vapt/controls.test.mjs (49/49)","node scripts/cli.mjs validate"]}
{"event":"CONFIRM","run_id":"wf-1794208398","review_execution":"ais4a-review-1","candidate_id":"d8ad927ecbae0d9fd4a1bbcc23873a75e1db57fbd80c8e7b6a34a5778d92a031","reviewer":"opus","second_opinion":"codex: 8/9 fixed, prevent-text drift check still lexical","outcome":"FAIL","open":["CFG-03 predicate still narrow (N1)","WEB-04 drops login/logout CSRF and send-only handlers (N2)","business-invariant vs client-callable RPC contradiction (N3)","API-05/WEB-01/WEB-02/API-08 predicates miss surfaces named in their prevent text (N4)"]}
{"event":"FAIL","run_id":"wf-1794208398","phase":"REVIEW","wave":"A","evidence":"confirmation FAIL after the one allowed repair batch; candidate frozen at d8ad927e; no further candidate edits","remaining":"mechanical predicate widening + selection tests; structural proposal: deny-list model (every [NN] control applies to every boundary kind unless narrowed with a recorded reason)","at":"2026-11-09T07:46:58.366Z"}
{"event":"RETRY","run_id":"wf-1794208398","review_execution":"ais4a-review-2","predecessor":"ais4a-review-1","authorized_by":"owner (chat, 2026-11-09: \"do the recommended\")","scope":"Wave A only: structural predicate-accounting fix + open findings N1-N4, prevent-text drift, minors; then one new bounded REVIEW (one repair + one confirmation)","at":"2026-11-09T08:00:28.407Z"}
{"event":"REVIEW","run_id":"wf-1794208398","review_execution":"ais4a-review-2","wave":"A","profile":"ELEVATED","candidate_id":"32650e0cc095f322425552d1a7f4bc884688a0147a986c63412d914558d8b769","primary":"opus","second_opinion":"codex 0.166.0","outcome":"FAIL","findings":{"blocker":2,"major":5,"minor":3,"codex":5}}
{"event":"REPAIR","run_id":"wf-1794208398","review_execution":"ais4a-review-2","phase":"REVIEW","batch":1,"candidate_id":"0ad6c39c6d335e94e4f52babcf40f1ca19e7b677bcb04710a9b803cf25e30b78","rerun":["node --test skills/vapt/controls.test.mjs (84/84)","node scripts/cli.mjs validate"],"class_rule":"a not_applicable reason may not defer to another boundary kind; NN controls default to all kinds"}
{"event":"CONFIRM","run_id":"wf-1794208398","review_execution":"ais4a-review-2","candidate_id":"0ad6c39c6d335e94e4f52babcf40f1ca19e7b677bcb04710a9b803cf25e30b78","reviewer":"opus","outcome":"PASS","second_opinion":"codex: 4 of 5 prior fixed; open: semantic tautology of ABUSE recipes (inherent), deletable non-ABUSE verify.pattern (test gap), attempt_limit wording, CFG-04/WEB-01 recipe breadth","disposition":"none weakens a gate or drops a present control; catalog has no consumer until Wave B; owner decision requested on residuals"}
{"event":"SHIP_READY","run_id":"wf-1794208398","wave":"A","candidate_id":"0ad6c39c6d335e94e4f52babcf40f1ca19e7b677bcb04710a9b803cf25e30b78","approved_plan_digest":"sha256:84c64a3f815d979d4959e21fb56a9776cd6c0c756e99d9f8d957af1ed8415ba1","residuals_to_wave_b":["non-ABUSE verify.pattern deletion not caught","attempt_limit wording","CFG-04/WEB-01 recipe breadth","evaluator shared module (controls.mjs)"],"decision":"owner chat 2026-11-09: ship Wave A, fix in Wave B","session_log":"none (repo has no session-log.md)"}
<!-- RUN-STATE:END -->
