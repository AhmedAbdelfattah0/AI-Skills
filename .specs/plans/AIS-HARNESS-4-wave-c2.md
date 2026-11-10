---
ticket: AIS-HARNESS-4 Wave C part 2 (local key; no tracker)
branch: feat/AIS-HARNESS-4-wave-c2-effectiveness
run_id: wf-1794300183
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

# Plan — AIS-HARNESS-4: Wave C part 2 (effectiveness report) + Wave B follow-up fixes

## Context
Waves A, C-1 and B are merged. Two things are pending: the effectiveness measurement and report (AC7), and two small review fixes left open when PR #44 merged. Each gets its own branch and PR. You merge.

## Decisions for you (approving accepts the default)
| # | Decision | Default |
|---|---|---|
| 1 | Second set of test cases that is not StoreCraft | Real public security advisories from GitHub, picked by a fixed rule with no human choice. (Your old pen-test reports are not on this machine; they can be added later.) |
| 2 | Proof that the scoring rules were fixed before any result existed | I open one public issue on this repo and post only file hashes in it (GitHub's timestamps prove the order). |
| 3 | Live before/after run with a model on 3 tasks | Off. The report will say it was not run. |
| 4 | Privacy (this repo is public, StoreCraft is not) | StoreCraft code, paths, commit text and finding text stay on this machine. Only finding IDs, group names and true/false values are committed. |
| 5 | The two leftover fixes | Separate small PR (Ticket 2), same run. |

---

# Ticket 1 — Wave C part 2: effectiveness scoring and report

**Shape:** tooling (Node scripts, data, report; no UI) · security-sensitive: no (measures; changes no gate) · review: ELEVATED (the deliverable is a set of claims; honesty is the acceptance criterion) · branch `feat/AIS-HARNESS-4-wave-c2-effectiveness`

## 1. What & why (read this first)
You get a report that says, in counts, how well the security catalog picks the right checks. It measures only; the catalog and the engine do not change. It covers the 24 real StoreCraft findings (described from the real pre-fix code by an agent that never saw the catalog) and about 24 public advisories from other projects. It never says "improves security", and it lists what was not measured.

## 2. Integration contract and execution DAG
### Integration contract
NOT_TRIGGERED — no producer/consumer boundary changes.

### Execution DAG
| ID | Owner | Step (plain words) | Files touched | Depends on |
|---|---|---|---|---|
| prereg | orchestrator | Write the scoring rules file exactly as approved here; post its hash and the catalog hash to the issue | `effectiveness/prereg.json` | — |
| recheck | sonnet agent | Re-check one fact (`attempt_limit`) in the 35 existing scenarios against its reworded definition; re-seal only if a value changes | `skills/vapt/fixtures/*` (conditional) | prereg |
| tools | sonnet builder | Scorer and its tests (failing first on made-up inputs), the advisory picker, the local StoreCraft export helper, one CI line | `effectiveness/{score,build-corpus2,prep-local}.mjs`, `skills/vapt/effectiveness.test.mjs`, `.github/workflows/validate.yml` | prereg |
| corpus2 | orchestrator | Run the picker; post the list's hash before anyone reads it | `effectiveness/corpus2-index.json` | tools |
| facts | 4 sonnet agents (2 StoreCraft, 2 advisories), ≤3 at once | Each writes the facts for its cases from the code. They see the fact definitions and the code only | `effectiveness/{storecraft,corpus2}-facts.json` | corpus2, recheck |
| judges | 2 opus agents, independent | Each marks, per case, which checks would catch the real weakness (yes / partly / no). They never see what was selected | `effectiveness/{storecraft,corpus2}-judgments.json` | corpus2 |
| score | orchestrator | Hash the inputs, post the hashes, run the scorer once | `effectiveness/{manifest,results}.json` | facts, judges, tools |
| report | sonnet builder | Report text around the generated results block; README pointer | `effectiveness/{REPORT,README}.md`, `skills/vapt/fixtures/README.md` | score |

(`effectiveness/` = `skills/vapt/fixtures/effectiveness/`.)
**Decomposition:** ONE unit · rationale: one pipeline with a single join (the scoring run); no shared contract with other code.

**Design Contract (every path that may change):** the files above, plus `.specs/plans/AIS-HARNESS-4-wave-c2.md`. Only if the re-check changes a value: `skills/vapt/fixtures/{scenarios,labels,amendments_round4,label_history,disagreements,manifest}.json` and `skills/vapt/fixtures.test.mjs` (re-seal v6, same independent author and labeler roles as rounds 1–3). **Never touched:** `skills/vapt/controls.json`, `skills/vapt/controls.mjs`, `skills/security-audit`, `skills/ship-ticket/scripts/*`.

**What is measured (fixed before any run; counts only, no percentages):**
| # | Measure | How |
|---|---|---|
| R0 | Selector follows the catalog (already in CI) | restated after the re-check |
| R1 | Do the catalog-blind agent's facts agree with the 12 existing reference scenarios | per fact: agree / differ each way / unknown. Reported as agreement, not error: the reference facts were tuned to the catalog |
| R2 | For each of the 24 findings, is the check that was written for it selected from the blind facts | selected / selected only because a fact was "unknown" / not selected. Ticket text = the commit messages that wrote the cited lines (mechanical, `git blame`) |
| R3 | How much each group of findings depends on the checks written from it | per group, remove every check with a source in that group, and once remove all 8 abuse checks; count findings still caught by a specific check both judges accept |
| R4 | Public advisories (the only non-StoreCraft data) | per case and specific check: needed and selected / needed and missed / not needed but selected / not needed and left out; cases with no check in the catalog at all; per weakness type; same counts for "select everything" and "select the always-on 11" |
| R5 | Breadth | checks selected per case (min / median / max) |

"Specific check" = one of the 14 checks that are not selected for every kind of change (`boundaryUniversal`, `skills/vapt/fixtures/selector.mjs:65`); without this, "at least one right check was selected" would always be true. A check counts as right only when both judges say yes; judge agreement and agreement with the Wave A mapping are reported.

**Advisory picking rule (no judgment):** GitHub Advisory Database, reviewed, npm and pip, published from 2026-08-01, newest first; keep an advisory when it links a fix commit on GitHub that changes 1–5 non-test source files totalling ≤200 KB; at most 2 per weakness type; stop at 24; every skipped ID is logged with the rule that excluded it. Only IDs, commit SHAs and paths are committed; the code is fetched on demand (no upstream code copied into this repo).

**Claim rules (fixed now):** never "improves security"; R1–R3 are always labelled "retrospective, in-sample, development data"; a sentence about working beyond StoreCraft is allowed only if, in R4, a needed specific check is selected in at least half of the cases that need one **and** it leaves out at least as many unneeded specific checks as it selects. Otherwise the report must say "on this corpus the catalog did not show useful selection". Failures are listed for follow-up; nothing is tuned in this wave.

## 3. Risks & unknowns
| Risk / unknown | Why it matters | What I'll do |
|---|---|---|
| Agents can open any file | "never saw the catalog" is by instruction, not enforced | inputs-only folder, each agent lists the files it read, stated as a limit |
| The fact definitions contain examples taken from the audit | the fact writer is catalog-blind but audit-exposed on StoreCraft | label R1–R3 in-sample; only R4 can support a wider statement |
| Results may be unflattering or the advisory set may hold few business-abuse cases | tempting to adjust | report as found, per weakness type; catalog hash test fails if the catalog changes |
| Both judges are the same model family | correlated judgment | both-yes rule, agreement counts, reviewer spot-check of 10 labels; stated limit |
| The re-check changes a sealed value | baselines move | re-seal v6 before scoring; old and new baselines both recorded |
| StoreCraft inputs are local only | reviewers cannot re-run that part | their hashes are recorded; the report says this cannot be checked from the public repo |
| Engine test suite is load-flaky on clean main | false alarm | rerun a failing file alone before calling it a regression |

### 3a. Security risk assessment
No security-relevant surface: offline scoring scripts, data files and a report under `skills/vapt/fixtures/effectiveness/`; no route, auth, tenancy, secret or gate change. Run started before the policy-2 cutoff (2026-11-12).

## 4. How I'll prove it works
- Scorer tests fail first, then pass, on made-up inputs: a caught case, a missed case, a removed check, an "unknown" fact.
- Mutation tests: flipping a fact, dropping a judge "yes" or removing a check must change the counts; committed inputs hold facts and judge labels only, never selections; the scorer uses the one evaluator in `skills/vapt/controls.mjs` (identity check).
- `node --test skills/vapt/effectiveness.test.mjs`: file hashes equal the posted ones, catalog hash equals the frozen one, `results.json` regenerates byte for byte, the report's results block equals the generated block, the claim sentence is the one the rule selects.
- Unchanged and green: `node --test skills/vapt/controls.test.mjs skills/vapt/fixtures.test.mjs`, `cd skills/ship-ticket/scripts && node --test`, `node scripts/cli.mjs validate`, `git diff --exit-code main -- skills/vapt/controls.json skills/vapt/controls.mjs skills/security-audit`.
- Grep proof that no StoreCraft path, commit text or finding title is in any committed file.

## 5. Not in this ticket
- Any catalog, predicate or engine change; any fix for a weakness the measurement finds (follow-up list only).
- The live before/after model run; time and token cost (one `select` wall-time observation only, marked as a single run).
- An ADD_CONTROLS fixture; the other Wave B residuals recorded in the Wave B run state.

## 6. Rejected alternative
A second corpus written by an agent from invented scenarios: weaker than real advisories, because its author shapes both the weakness and the code.

## 7. Cross-model planning debate
**Result:** SKIPPED (not a money/auth ticket). One Opus design review of the measurement instead, 12 findings, all dispositioned:
| Finding / severity | Disposition |
|---|---|
| "At least one right check selected" is always true (11 checks always fire; unknown selects everything) / blocker | fixed: specific checks only, baselines side by side, unknown-dependence counted (R2–R4) |
| Ticket text written by someone who saw the finding leaks the answer / major | fixed: commit messages via `git blame` for StoreCraft; real pre-fix code, no written ticket, for advisories |
| Fact writer is not blind to the audit (definition examples) / major | accepted and labelled; R1–R3 in-sample |
| Hold-out rule kept checks that leak; conditions derived from a group remain on other checks / major | fixed: "any source" rule plus an all-abuse-removed fold; named "dependence", not hold-out generalization; per-fold rebuild stated as not feasible |
| One judge, three-level scale / major | fixed: two judges, both-yes rule, agreement counts, Wave A concordance |
| Order of pre-registration not provable in one commit / major | fixed: hashes posted to a public issue (decision 2) |
| Reference facts tuned to the catalog / major | fixed: agreement wording; source-check selection added (R2) |
| Advisory sampling bias, memorised advisories / major | fixed: mechanical rule, recent window, per-type breakdown, hash posted before anyone reads |
| Tests could pass without the scorer running / major | fixed: mutation tests, no stored selections, evaluator identity |
| Missing: no-tuning rule, "not run" record, re-check before R0 / minor | added |
| Token and time cost unverifiable / minor | cut to breadth plus one observation |
| Judge rationales and local hashes / minor | rationales stay local; limit stated |

**Outstanding decisions:** the five in the table at the top. Model agreement is advice, not approval.

## 8. Proof and review routing
| Work | Scope for this ticket | Execution |
|---|---|---|
| parity | not triggered | — |
| attack inventory | not triggered (no trust boundary) | — |
| rule coverage | Node scripts and tests (code-quality hub, test-quality), report text (docs-accuracy) | one Opus primary review: every number in the report against `results.json`, every claim against the claim rules, 10 judge labels spot-checked, privacy grep |
| second opinion (mandatory) | every ticket | Codex if its quota is back, else CodeRabbit, alongside the primary |

**Ship threshold:** wording or cosmetic issues ship with a follow-up. These block: a number that does not regenerate, a claim outside the claim rules, any StoreCraft detail in a committed file, a broken blindness or ordering record, any change to the frozen catalog.

---

## Verification (both tickets)
Commands in each section 4, then CI green on each PR. Expected agent runs: about 10 for Ticket 1 (1 re-check, 2 builders, 4 fact writers, 2 judges, 1 review) and 2 for Ticket 2, plus the second opinions.

<!-- RUN-STATE:BEGIN -->
{"event":"START","run_id":"wf-1794300183","approved_plan_digest":"sha256:357229b0395128384d07f64203752ed2d7e361350fe9879e7c27e8bc7b7dde42","digest_procedure":"sha256 of the plan file with the text between the RUN-STATE markers removed (markers kept adjacent)","approved_via":"ExitPlanMode (one approval for both tickets, 2026-11-10)","recorded_at":"2026-11-10T08:53:25.207Z","base":"main@111c06f","scope":"Wave C part 2 only: measurement and report; catalog and engine frozen"}
{"event":"PREREG","run_id":"wf-1794300183","prereg_sha256":"12bc56f7491fbb9a727373e6a419c5be3c3a25f7ccaf36a1239de12612d8ca02","posted":"https://github.com/AhmedAbdelfattah0/AI-Skills/issues/45","recorded_at":"2026-11-10T09:44:48.256Z"}
{"event":"DEVIATION","run_id":"wf-1794300183","items":["fact writing took 11 sonnet runs (8 development batches of 3, 3 public batches of 8) instead of the planned 4: the cited files are 80 to 470 KB per case","the writers' instruction file was edited once before any writer ran (large files may be read by region)","the attempt_limit re-check changed one sealed value (S-SEA-18 unknown to false): fixtures re-sealed at version 6 before scoring, selection for that scenario unchanged","report and README prose written by the orchestrator instead of a sonnet builder; checked by the independent primary review"],"recorded_at":"2026-11-10T09:44:48.256Z"}
{"event":"REVIEW","run_id":"wf-1794300183","review_execution":"ais4c2-review-1","profile":"ELEVATED","candidate_id":"5c3f164ded696aa7a2617612710e120f2c1ba8630ce50c3243b1f705247395d2","primary":"opus","second_opinion":"coderabbit 0.7.6 (codex quota back 2026-11-11): 0 findings, 21 files","outcome":"FAIL","findings":{"blocker":0,"major":1,"minor":5},"note":"major: R1-R3 result sentences in the report prose lacked the in-sample label the claim rules require; reviewer recomputed every checked measure and the claim decision independently and they match; picker re-run reproduces the index byte for byte","recorded_at":"2026-11-10T09:44:48.256Z"}
{"event":"REPAIR","run_id":"wf-1794300183","review_execution":"ais4c2-review-1","phase":"REVIEW","batch":1,"candidate_id":"5b35cd9b21f27678552d35bdc94f6dddf2867bf9a32b9fd73756501d8acfb231","fixed":["C2R1-01 label added to the R1, R2, R3 bullets","C2R1-02 sentence corrected: selection left out unneeded controls on the public cases but no case needed a specific one","C2R1-03 shared fix commit of C2-11 and C2-12 added to Limits","C2R1-04 renderBlock prints a limit line under R5 and Judges; listed in the report as a post-scoring scorer change; results.json byte-identical (0a8e39ba...)","C2R1-05 test regex tightened","C2R1-06 ordering wording now matches what the posts show"],"rerun":["node --test skills/vapt/effectiveness.test.mjs (45/45)","controls + fixtures + security-plan tests (178/178)","node scripts/cli.mjs validate"],"recorded_at":"2026-11-10T09:44:48.256Z"}
{"event":"CONFIRM","run_id":"wf-1794300183","review_execution":"ais4c2-review-1","candidate_id":"5b35cd9b21f27678552d35bdc94f6dddf2867bf9a32b9fd73756501d8acfb231","reviewer":"opus","second_opinion":"coderabbit 0.7.6 on the repaired candidate: 0 findings, 21 files","outcome":"PASS","per_finding":"C2R1-01..06 all fixed","new_minor":[{"id":"C2C1-01","summary":"REPORT.md \"Listed for follow-up\": the bullets that restate development results (22 to 25 controls per case; F21 has no control both judges accept) lack the in-sample label; the statements are true","disposition":"ships under the plan threshold (wording); candidate frozen after PASS; listed in the PR for the next round"}],"recorded_at":"2026-11-10T09:46:55.969Z"}
{"event":"SHIP_READY","run_id":"wf-1794300183","candidate_id":"5b35cd9b21f27678552d35bdc94f6dddf2867bf9a32b9fd73756501d8acfb231","evidence":["node --test skills/vapt/effectiveness.test.mjs 45/45","controls + fixtures + security-plan tests 178/178","node scripts/cli.mjs validate pass","frozen paths byte-identical to main: skills/vapt/controls.json, skills/vapt/controls.mjs, skills/security-audit, skills/ship-ticket","results.json sha256 0a8e39baa70704046a67df1a06e15269f12a4fbd619d71808dd06dde23891eae, unchanged by the repair","issue #45 posts equal the committed hashes"],"not_verified":["fact writers' and judges' blindness (by instruction only)","the local-only development input hash, from the public repository","full ship-ticket engine suite locally: no ship-ticket file changed; CI runs it"],"recorded_at":"2026-11-10T09:46:55.969Z"}
{"event":"RETRY","run_id":"wf-1794300183","review_execution":"ais4c2-review-2","predecessor":"ais4c2-review-1","authorized_by":"owner (chat, 2026-11-10: \"don't let any leftovers I need to cover everything\"; closing plan approved via ExitPlanMode)","scope":"CodeRabbit review of PR #47 (prep-local blob check, skip-rule check that could turn itself off, pager error, description comments), the in-sample labels (C2C1-01 and CodeRabbit), follow-up wording; no data, rule or count change","recorded_at":"2026-11-10T10:59:21.265Z"}
{"event":"CONFIRM","run_id":"wf-1794300183","review_execution":"ais4c2-review-2","candidate_id":"dd959fb732ee69304e3ad10bca704fc05539e7f955ee6ac98d448dce1a1ca775","reviewer":"opus","second_opinion":"coderabbit 0.7.6: 0 findings on the touch-up","outcome":"PASS","checked":["results.json sha256 0a8e39ba... unchanged and regenerates","only the skip-rule check changed in score.mjs logic; other additions are comments","fixes 1 and 2 reverted in a scratch copy make exactly their new tests fail","picker re-run with the same freeze reproduces corpus2-index.json byte for byte (orchestrator)"],"minor":["REPORT.md one long line after a reflow","REPORT.md Limits: \"the facts are broad\" without a development-data word"],"recorded_at":"2026-11-10T10:59:21.265Z"}
{"event":"NOTE","run_id":"wf-1794300183","what":"the two wording minors of ais4c2-review-2 were applied after the confirmation, under the owner's no-leftovers instruction: one paragraph re-wrapped, \"the facts\" changed to \"the development facts\". Verified mechanically only (results.json unchanged, 48/48 tests incl. the report-block check, validator); no further review.","candidate_id":"a2fc03b365df326811ceb59239f49863e8ec6f883a8bdeed39866f2fd942b7d2","recorded_at":"2026-11-10T10:59:21.265Z"}
{"event":"SHIP_READY","run_id":"wf-1794300183","candidate_id":"a2fc03b365df326811ceb59239f49863e8ec6f883a8bdeed39866f2fd942b7d2","evidence":["node --test skills/vapt/effectiveness.test.mjs 48/48","controls + fixtures + security-plan tests 178/178","node scripts/cli.mjs validate pass","results.json sha256 0a8e39baa70704046a67df1a06e15269f12a4fbd619d71808dd06dde23891eae","the six input hashes equal issue #45 post 3"],"recorded_at":"2026-11-10T10:59:21.265Z"}
<!-- RUN-STATE:END -->
