---
ticket: AIS-HARNESS-4 Wave B follow-up (local key; no tracker)
branch: fix/AIS-HARNESS-4-wave-b-followup
run_id: wf-1794300805
timing_telemetry: active
native_plan_mode: active
plan_mode_carrier: claude
host_agent: claude
counterpart_agent: codex (quota back 2026-11-11), else CodeRabbit
plan_debate: {status: SKIPPED, reason: "not money/auth; replaced by one Opus design review, section 7"}
worker_width: 3
parallelism_degradations: []
approval_status: approved
ui_required: false
base: main@111c06f
execution: manual flow with Agent dispatch, as in Waves A, C-1 and B (engine helpers not used: declared degradation)
---

# Plan — AIS-HARNESS-4 Wave B follow-up: two review fixes

Approved together with Wave C part 2 in one ExitPlanMode (decision 5: separate small PR, same run). The Wave C part 2 plan is `.specs/plans/AIS-HARNESS-4-wave-c2.md` on its own branch.

**Shape:** harness engine (Node) · security-sensitive: yes (gate logic) · review: ELEVATED · branch `fix/AIS-HARNESS-4-wave-b-followup` (separate git worktree, so it can run beside Ticket 1)

## 1. What & why
Two points CodeRabbit raised on PR #44 that were valid and left open at merge. (a) After the proof commands run, the engine re-checks each security pair using a remembered base commit, so a proof command that moves the base (an empty commit) is not noticed in that re-check. The fix forgets the remembered value first. (b) One test builds a file path in a way that breaks on paths with special characters; it switches to the standard converter.

## 2. Execution DAG
| ID | Owner | Step | Files touched | Depends on |
|---|---|---|---|---|
| fix | opus builder (gate logic) | Failing test first: a proof that moves the base must leave the pair unproven. Then the one-line fix, a named mutant (S28), and the path fix | `skills/ship-ticket/scripts/{engine-gates.mjs,run-engine-security.test.mjs,engine-security-mutation.test.mjs}` | — |

**Design Contract:** those three files plus `.specs/plans/AIS-HARNESS-4-wave-b-followup.md`. Integration contract: NOT_TRIGGERED. Decomposition: ONE unit.

## 3. Risks & unknowns
| Risk / unknown | Why it matters | What I'll do |
|---|---|---|
| Clearing the cache changes other callers in the same run | a wider behaviour change than intended | builder traces every `E.baseCommit` reader (`engine-attempts.mjs:75`, `engine-gates.mjs:122-127,434`); full engine suite must stay green; grandfathered golden test unchanged |
| The failing case may already be refused by another check | then the test proves nothing | the red run must fail on the pair's status, not on another refusal; if it cannot be made red, report it and drop (a) rather than ship an untested change |

### 3a. Security risk assessment
No new security-relevant surface: tightens an existing re-check inside `gate ship-ready`; no route, principal, data or secret changes. Run started before the policy-2 cutoff.

## 4. How I'll prove it works
- New test red before the fix (recorded), green after; mutant S28 (fix removed) fails on that test and the control copy passes (`ENGINE_SECURITY_MUTATION=1`).
- `cd skills/ship-ticket/scripts && node --test` all green, golden test byte-identical; `node scripts/cli.mjs validate`.

## 5. Not in this ticket
The other recorded Wave B residuals (surface-path test pinning, `--import=` preload attribution, standalone `reassess --inventory` re-pathing, and the rest in the Wave B run state).

## 6. Rejected alternative
Folding these into the Ticket 1 PR: it would mix an engine change into a wave whose rule is "engine and catalog frozen while measuring".

## 7. Cross-model planning debate
SKIPPED: two-line fix already specified by the PR review; no design choice open.

## 8. Proof and review routing
Opus primary review (gate logic) plus the mandatory second opinion (Codex if back, else CodeRabbit). A repair, if any, gets the second opinion before the confirmation. **Ship threshold:** anything that weakens a gate or fail-closed behaviour blocks; wording ships with a follow-up.

<!-- RUN-STATE:BEGIN -->
{"event":"START","run_id":"wf-1794300805","approved_plan_digest":"sha256:7ca8932cea26e5e5fe44aa8df0aabb7504056c855de6b57d528c7a9b13eb238f","digest_procedure":"sha256 of the plan file with the text between the RUN-STATE markers removed (markers kept adjacent)","approved_via":"ExitPlanMode (one approval for both tickets, 2026-11-10)","recorded_at":"2026-11-10T08:53:25.207Z","base":"main@111c06f","scope":"Wave B follow-up only: base-commit cache re-check and one test path fix"}
{"event":"RED","run_id":"wf-1794300805","node":"fix","spec":"run-engine-security.test.mjs [S28]","failed_on":"gate ship-ready returned ship_ready (exit 0) where control_unproven (exit 2) was expected; RED bound to the old HEAD, proof moved HEAD, candidate unchanged","recorded_at":"2026-11-10T09:17:56.614Z"}
{"event":"REVIEW","run_id":"wf-1794300805","review_execution":"ais4bf-review-1","profile":"ELEVATED","candidate_id":"ddf27ce8cf75b992abbf3c855cd0bd779def4b24e95e26303c99f912e1fe809d","primary":"opus","second_opinion":"coderabbit 0.7.6 (codex quota back 2026-11-11): 0 findings","outcome":"PASS","findings":{"blocker":0,"major":0,"minor":1},"dispositions":[{"id":"R1","severity":"minor","summary":"post-proof path reuses the pre-proof security context (catalog not re-read after the proof)","disposition":"no change: controlPairs reads only sec.events.pairs and sec.waived (in-memory state), never catalog bytes, so a catalog rewritten by a proof command cannot change a pair verdict in that call; the next gate call re-derives the context and refuses a changed catalog digest. Pre-existing, recorded as a residual."}],"recorded_at":"2026-11-10T09:17:56.614Z"}
{"event":"SHIP_READY","run_id":"wf-1794300805","candidate_id":"ddf27ce8cf75b992abbf3c855cd0bd779def4b24e95e26303c99f912e1fe809d","evidence":["builder: full engine suite 536 pass, 0 fail, 2 skipped; mutation suite pass; cli.mjs validate pass","reviewer: run-engine-security 30/30, gate-security + run-engine-units 50/50, mutation suite pass, fix reverted in a scratch copy goes red for the stated reason"],"not_verified":["Windows behaviour of the path fix before CI"],"recorded_at":"2026-11-10T09:17:56.614Z"}
<!-- RUN-STATE:END -->
