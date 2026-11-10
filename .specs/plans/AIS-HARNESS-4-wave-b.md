---
ticket: AIS-HARNESS-4 Wave B (local key; no tracker)
base: main@65bebd0
branch: feat/AIS-HARNESS-4-wave-b-security-plan
owner_decisions: [freeze LIFTED (owner, this session), skills/vapt/controls.mjs approved, four Wave A residuals carried]
review: ELEVATED; primary opus; second opinion Codex (quota back 2026-11-11), else CodeRabbit; mandatory
orchestrator: sonnet; planners opus (2, read-only, done)
---

# Plan — AIS-HARNESS-4 Wave B: plan section, gate binding, reassess

## Context
Wave A (catalog) and C-1 (fixtures) are merged and nothing consumes them. Wave B makes security applicability come from the catalog, puts it in the approved plan, and makes `gate ship-ready` fail closed on it. Policy 2 applies only to new runs; earlier bound runs stay byte-identical. No claim that this improves security: only what the tests measure (selector fidelity vs fixtures).

## Design Contract (every path that may change)
**W1 vapt** — `skills/vapt/controls.mjs` (new), `controls.json`, `controls.test.mjs`, `fixtures.test.mjs`, `fixtures/{selector.mjs,manifest.json,README.md,disagreements.json (regenerated, must be byte-identical)}`, `SKILL.md` (1 sentence).
**W2 selector** — `skills/ship-ticket/scripts/security-plan.mjs` (+ `security-plan.test.mjs`).
**W3 engine/gate** — in `skills/ship-ticket/scripts/`: `harness.mjs`, `engine-dag.mjs`, `engine-gates.mjs`, `engine-authority.mjs`, `gate.mjs`, `run-state.mjs`, `run-engine.mjs`, `engine-test-fixture.mjs` (options only), `engine-mutation.test.mjs` (parameterise target tests), new `gate-security.test.mjs`, `run-engine-security.test.mjs`, `engine-security-mutation.test.mjs`.
**W4 docs/CI** — `skills/ship-ticket/{SKILL.md,references/security-risk.md (new),plan.md,prove.md,review.md,ship.md}`, `AGENTS.md` (list at :259), `.github/workflows/validate.yml`.
Never touched: `skills/security-audit`. **Beyond your written list, these need your approval with this plan:** `run-engine.mjs`, `engine-authority.mjs`, `engine-test-fixture.mjs`, `engine-mutation.test.mjs`, and the vapt fixture files (`selector.mjs`, `fixtures.test.mjs`, `manifest.json`, `README.md`). They are forced by init binding, authority events, and the drift-guard retarget.

## Agreed shapes (both planners)
- DAG config keys camelCase, not defaulted, added to `CONFIG_FIELDS`: `securityPolicy: 2`, `catalogDigest: "sha256:<hex of controls.json bytes>"`, `controlCoverage: [{boundary, control, node, specs:[{file,name}]}]` (`[]` = evidenced empty assessment). Each pair has its own spec; spec sits under that node's `writes`; outside it is contract expansion → WAIT_FOR_USER.
- Pair id `<boundary_id>:<control_id>`, parsed by splitting on the last colon. Review `rule_rows[].subject_id` = pair id.
- Narrative carries a machine line `security-pairs sha256:<hex>` (canonical JSON of policy, catalog digest, sorted pairs) inside the plan digest; `init` refuses on any mismatch with the DAG (`security_pairs_mismatch`). `select` emits §3a rows, the machine block and a config fragment; the planner fills node/spec.
- `security-plan.mjs` exports `loadCatalog`, `catalogDigest`, `selectControls`, `pairsLine`, `parsePlanSecurityBlock`, `effectiveSet`, `reassessSignals`, `reassess`, `pairId/parsePairId`, imports nothing from the engine. CLI `select|reassess`; exit 0 result, 2 refusal/judgment (`catalog_missing` is never an empty selection), 1 bad input. Facts must each cite a path or say `unknown: why`; unknown keeps the control.
- Events: `SECURITY_ADDENDUM` and `SECURITY_WAIVER` are authority events (add to `AUTHORITY_EVENTS`; worker forgery refused; one appended while work is live is refused). `SECURITY_REASSESSED` is engine-recorded, not authority. Effective addendum set is re-derived from trusted events each call, never stored → add-only across resume.
- Freshness tuple: candidate_id + approved_plan_digest + catalog_digest + addendum set. A stale tuple refuses review and ship-ready; recovery is an owner RETRY, not a free refresh.

## Behaviour rules
1. **Grandfathering** by trusted START approval time vs `SECURITY_POLICY_CUTOFF` (set in the merge commit, after every fixture date), never by a missing field; checked at `init` and `verifyBinding`. Older runs: existing golden test and all engine suites unchanged, plus a no-security-vocabulary assertion. Post-cutoff runs without `securityPolicy: 2` → `security_policy_required`.
2. **Spec must show pass, not skip**: `runProof` parses formatted test output into `spec_results` (only under policy 2); `gateRed` gets a `red_addendum` slot; `gate ship-ready` adds `control_unproven` per unproven pair (RED accepted, RED not rewritten after, named spec pass, freshness), evaluated after the proof runs so the first call does not deadlock on `missing_local_proof`.
3. **No escape**: `NOT_APPLICABLE` rows only for waived pairs; `security_outcome: NOT_TRIGGERED` rejected when effective pairs exist. `[D]` and `[NN]` pairs both need a pass or a waiver (so "DEGRADED blocks" = no PASS evidence refuses).
4. **Reassess** runs every engine run (no-op without signals; no stored artifact), after any repair touching mapped files, and before review and ship-ready. Outcomes UNCHANGED / ADD_CONTROLS (inside contract) / REAPPROVAL (new START + digest, WAIT_FOR_USER, `drive` stops). Unclassified signal → refuse.
5. **Plan §3a** required when ELEVATED, security-sensitive, `riskLabels` non-empty, or vapt fires; otherwise one line "No security-relevant surface: <evidence>".
6. **Consolidation**: spine "Security sensitivity", ELEVATED, `HIGH_RISK`, `CONFIRM_SECOND_OPINION` keep profile/routing/labels; only attack-class applicability moves to the catalog (table in `security-risk.md`). Second opinion is required when a repair overlaps a pair spec file.

## Residuals
(a) `verify.pattern` required and substance-checked for every control: test-only change (no catalog bytes).
(b) `attempt_limit` definition reworded to cover an uncapped alternate route + genuine negative example. (c) WEB-01 reflected-XSS and CFG-04 non-login cookie-issuer recipe rows. (b)+(c) change `controls.json` in **one** light catalog commit with predicates untouched: ledger regenerates byte-identical, baselines stay 231 / 47 / 11 and net hard defects 0 / 55 / 0. Re-seal v5 steps: new `catalog_digest_at_seal`, `version` 4→5, history entry, new `seal_anchor`, `fixtures.test.mjs` version pin 4→5, README lines. No scenario/fact edits (sealed set stays untuned); record the unaudited `attempt_limit` reword in `limits`.
(d) Evaluator moves to `controls.mjs` (exports `unknownish, assertFacts, holds, via, why, selected, catalogDigest, DIFF_SIGNALS`); `selector.mjs` becomes a thin re-export plus fixture-only scoring; the text drift guard is replaced by export-identity plus no-local-declaration checks.

## Build DAG (≤3 agents; fresh builders, no commits by workers)
- N1 W1 (sonnet) — move evaluator, then catalog commit, re-seal last. Independent.
- N2 W2 (opus; selection logic) — against pinned exports above; parallel with N1 after the pin, joins on the real `controls.mjs`.
- N3 W3 (opus; gate/state, security + concurrency labels) — one builder for the whole engine half (shared seams): dag/harness → authority/run-state → gate → engine-gates → run-engine → tests → mutation file. Parallel with N1/N2, imports the pinned `security-plan.mjs` exports.
- N4 W4 (sonnet) — docs, AGENTS.md, validate.yml; after N2/N3 shapes are final. Event names in `ship.md` must equal `AUTHORITY_EVENTS`.
Red first: each of N2/N3 writes its tests first and records RED (security-sensitive). Orchestrator owns the join, git, and the one commit/PR.

## Mechanical class rules (replace hand-patching)
- C1 every new refusal code is in an exported `SECURITY_CODES`; a meta-test needs a refusing row and an accepting twin differing by one field.
- C2 every guard has a named mutant; the suite must fail on its tagged test and pass on the control copy (new `engine-security-mutation.test.mjs`).
- C3 policy-1 parity: no new key, event or output. C4 derived-not-input fields rejected. C5 per event: trusted works / live-appended refused / worker append refused / rewritten-block untrusted. C6 each freshness part alone makes it stale. C7 spec-status matrix (pass/fail/skip/todo/missing/truncated/unformatted) across tap, jest, vitest. C8 first ship-ready runs proof, never loops. C9 narrative vs DAG mismatch in both directions. C10 two pairs, one proven → names the other. C11 spec rewritten after RED refused. C12 assert codes, not messages.
- Selector tests run both directions against the fixtures: `catalog_faithful` = 231 recall / 47 violations / 0 net hard defects; a treat-unknown-as-false variant recalls less; all-controls scores 55; boundary-universal scores 121/231; swapping planned/actual does not give REAPPROVAL from facts alone; catalog-digest mismatch or out-of-contract path → REAPPROVAL; a classification can never remove an approved pair.

## Review, ship threshold, run-state
Primary Opus review (code + security), then mandatory second opinion: Codex if available, else CodeRabbit; if neither, stop and ask. Repairs to N3/N2 (security/concurrency) get the second opinion **before** the Opus confirmation. Ship threshold: wording/cosmetic doc issues of medium or lower ship with a follow-up; anything weakening a gate, fail-closed logic, binding, authority events, grandfathering, or the digest/seal blocks. Append Wave B START/REVIEW/REPAIR/CONFIRM/SHIP_READY events to RUN-STATE in `.specs/plans/AIS-HARNESS-4.md` (outside the Wave A digest region); update `branch_per_wave`. Missing Node: helpers are a declared degradation and the plan says so. AC3 reading: no new *files* when reassess finds no signals; ship-ready recomputes it deterministically.

## Verification
`cd skills/ship-ticket/scripts && node --test` (all, incl. golden and new suites); `node --test skills/vapt/controls.test.mjs skills/vapt/fixtures.test.mjs`; `node skills/vapt/fixtures/make-ledger.mjs` then `git diff --exit-code skills/vapt/fixtures/disagreements.json`; `node scripts/cli.mjs validate`; `git diff --exit-code skills/security-audit`; `security-plan.mjs select|reassess` on fixtures; grep proof that no stale phrase remains (old drift-guard text, "NOT_TRIGGERED" accepted rules); validate.yml lists the four new test files. Measure helper overhead for AC8. One branch, one commit, one PR; you merge.

## Open risks (accepted, stated)
Backdating START bypasses the cutoff (same trust level as the plan digest today). The daily catalog auto-update makes in-flight reviews stale by design. Sealed set remains weakly independent; the `attempt_limit` reword is not fact-audited until Wave C. Wave C part 2 (effectiveness scoring/report) follows Wave B.
