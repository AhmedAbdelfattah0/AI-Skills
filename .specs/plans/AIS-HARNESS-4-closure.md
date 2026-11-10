---
wave: AIS-HARNESS-4 closing pass (no leftovers)
approval_status: approved (ExitPlanMode, 2026-11-10)
run_id: wf-closure-1794310000
timing_telemetry: degraded (not recorded for the closing pass)
host_agent: claude
counterpart_agent: codex (quota back 2026-11-11), else CodeRabbit
worker_width: 3
base: main@0eb0e49 (PR #46 merged as 5a3793c, PR #47 merged as 0eb0e49)
execution: manual flow with Agent dispatch, as in the earlier waves
---

# Plan — AIS-HARNESS-4 closing pass: cover every leftover

## Context
The owner said (2026-11-10): "don't let any leftovers, I need to cover everything because I have more enhancements coming and I need to close this one first." Waves A, C-1, B are merged. PR #46 (Wave B follow-up) and PR #47 (Wave C part 2) are reviewed, CI green, unmerged. This pass ends every open item as one of: fixed, intended and documented, or waiting on the owner for one named input.

## Owner decisions
| # | Decision | Status |
|---|---|---|
| 1 | I fix the CodeRabbit points in #47, re-check, then squash-merge #46 and #47 myself | **Answered: yes, merge both** |
| 2 | Loose gate rule (a written reason can close a route/login/migration alert inside a file the plan already lists) | **Answered: keep it, pin with tests, document as intended** |
| 3 | Re-run the StoreCraft part of the measurement on tighter inputs now, or record and hand over | **Answered: no re-run; record it as the first requirement of the next enhancement** |
| 4 | Testing the business-logic checks on another product | **Answered: no old reports exist. The owner has the Cloudflare audit skill (`skills/security-audit`) that produces such reports.** The closing record names it as the way to settle this: run that skill on another product, then score its findings with the tools in `skills/vapt/fixtures/effectiveness/`. Not run in this pass (a full audit of another product is a large job of its own) |
| 5 | Refuse backslashes in surface and changed-file paths (today they are silently converted) | default: yes (stricter only) |
| 6 | Small-fix plans: shrink the security section from 35 lines to 1 line plus 2 machine lines (AC8 promised "at most 1 line") and record one timing of the helper | default: yes |
| 7 | Engine test suite sometimes fails when the machine is busy (predates this ticket, CI stable) | default: capture the failing test names once, open one GitHub issue with that evidence; not fixed in this ticket |
| 8 | Catalog gaps the measurement found (parser/regex denial of service, log leaks, symlink escape, encoding; finding F21) | default: recorded as requirements for the next enhancement; the catalog is not changed now (a change makes today's measurement stale and needs the full catalog process) |
| 9 | Housekeeping after the merges: delete the merged branches (local and remote), remove the temporary worktree, close issue #45 with a final note | default: yes |

## Step 0 — finish PR #47, then merge #46 and #47
Fix in `skills/vapt/fixtures/effectiveness/` on branch `feat/AIS-HARNESS-4-wave-c2-effectiveness`:
- `prep-local.mjs:56` `existsAt`: accept only a file (`git cat-file -t` is `blob`). Did not affect the run (102 files, 1 missing, 0 folders).
- `REPORT.md`: add the in-sample label at line 57 and the two follow-up bullets (lines 284, 289).
- `score.mjs:470`: fail when no skip rules are parsed, with a negative test in `skills/vapt/effectiveness.test.mjs`.
- `build-corpus2.mjs:141`: clear error when the header/body separator is missing.
- Short description comments on the functions of the three scripts (CodeRabbit "docstring coverage").
Then: `score.mjs --write` (results.json must stay sha256 `0a8e39ba…eae`), `--report REPORT.md`, tests, validator, re-run the picker with `--freeze 2026-11-10T09:05:47Z` and compare the index byte for byte, one short Opus confirmation, amend the single commit, push with lease, wait for CI, squash-merge #46 then #47.

## Ticket 3 — closing hardening (one PR, branch `fix/AIS-HARNESS-4-closure-hardening`, from main after the merges)
**Shape:** harness engine · security-sensitive: yes · review: ELEVATED (Opus primary + second opinion; a repair gets the second opinion before the confirmation). Failing test first for every fix.

| Unit | Owner | Files | Items |
|---|---|---|---|
| U1 selector | opus builder | `skills/ship-ticket/scripts/security-plan.mjs`, `security-plan.test.mjs`, `skills/vapt/fixtures.test.mjs` | 3, 7a, 1+4 (tests only), 13, 21 |
| U2 gate | opus builder | `skills/ship-ticket/scripts/gate.mjs`, `gate-security.test.mjs`, `engine-dag.mjs` | 5, 7b, 8, 9, 11 |
| U3 engine | opus builder | `skills/ship-ticket/scripts/engine-gates.mjs`, `run-engine.mjs`, `run-engine-security.test.mjs` | 12, 6, 2 |
| join | orchestrator | `skills/ship-ticket/scripts/engine-security-mutation.test.mjs` (mutants S29–S36; add `security-plan.test.mjs` to its test list) | all |
| U4 docs/CI | sonnet builder | `skills/ship-ticket/references/security-risk.md`, `.github/workflows/validate.yml` | 14, 16, 32 |
Order: U1 first; U2 and U3 in parallel after it; then the join; then U4. Land before 2026-11-12 (policy start) so no run is caught mid-way; all changes only refuse more.

Fix designs (from the Opus inventory, verified against the code):
- **3 (major)** `reassess()` builds the surface union itself (approved block surfaces + inventory); identical surfaces dropped, a redefined boundary id refused `bad_input`; `engine-gates.mjs` `unionSurfaces` is deleted and uses it. Tests: re-pathed id gives `bad_input`; leaving approved surfaces out of the inventory gives the same result as including them. Mutant S29.
- **7a** surface paths and changed paths containing a backslash are refused `bad_input` (flips `security-plan.test.mjs:367`, decision 5). **7b** `sameFile` in `gate.mjs` converts backslashes only on drive-rooted or UNC result paths; `pairProblem` refuses a backslash in `spec.file`. Mutant S33.
- **1+4 (decision 2: keep)** tests only: an approved surface at a prefix or suffix path must not close the signal; two open signals with one classified must list exactly the other. Mutants S30, S31. Document in `security-risk.md` §7 as intended, with the reason.
- **13** pass the evaluator's `unknownish` down instead of the local copy; `catalog_missing` still refuses first; add `security-plan.mjs` to `checkSharedEvaluator`.
- **21** `renderSection3a` emits the compact form when nothing is selected (1 prose line, pairs line, machine block). Timing: 20 runs each of `select` and `reassess` on a fixture, median and 95th percentile, recorded in the closing record.
- **5** `soleFile` attributes a TAP pass only when every option is on an allowlist (`--test`, `--test-reporter=tap`, `--test-reporter-destination=stdout`, `--test-name-pattern=`, `--test-concurrency=`, `--test-timeout=`, `--no-warnings`); `--import=`, `--require=`, `-r=`, `--loader=`, `--test-reporter=./x.mjs` give `missing`. Keep `run-engine-security.test.mjs:253` passing. Mutant S32.
- **8, 9** add UNC and four-backslash rows to the Windows location test; correct the Node 20+ comment. **11** unescape `# Subtest` names in `parseTap` with a nested-name test (rerun the golden test).
- **12** after the proof and the candidate check, rebuild the security context and rerun `securityRefusal ?? reassessRefusal ?? coverageRefusal`; on refusal record `local_proof` with `candidate_id: null`. Test: the proof rewrites the catalog file and ship-ready returns `reassess_stale`. Mutant S34.
- **6** `bindSecurity` refuses `security_pairs_mismatch` when an approved surface lies outside every node's `writes` (one helper shared with `engine-gates.mjs:501`). Mutant S35.
- **2** S25/S27 engine tests become a table over all three surface kinds.
- **14** top-level `permissions: contents: read` in `validate.yml`. **16** reword "options written `--flag=value`" to "only the listed options". **32** add to §3: "A surface path is a file; a directory path matches no signal."

Risks: golden byte-identity test (item 11), intentional test flips (`:367`), Windows jobs (canned Windows rows run on every OS; Node 18 locations are `file:///` URLs), suite flakiness under load (run mutants at concurrency 1).

## Ticket 4 — closing record (one small PR after Ticket 3, branch `docs/AIS-HARNESS-4-closure`)
- `.specs/reviews/AIS-HARNESS-4/closure.md`: AC1–AC8 each with its evidence; every item of the inventory below with its final state and where it is fixed or documented; the measurement findings handed to the next enhancement; what waits on the owner.
- A `CLOSED` event appended to the RUN-STATE of `.specs/plans/AIS-HARNESS-4.md` (outside the digest) listing every wave, branch and PR (this also settles the `branch_per_wave` front matter that cannot be edited).
- Decisions 3 and 4: no new measurement in this pass. The closing record states both as open, in plain words: what was found, what was not tested, and what input would settle it.
- Decision 7: one diagnostic run to capture failing test names, one GitHub issue.
- Decision 9 housekeeping.

## Inventory and final state
| id | Item | Final state |
|---|---|---|
| 1+4 | Reason can close an alert on an approved path | kept by decision 2; pinned by tests; documented |
| 2, 3, 5, 6, 7, 8, 9, 11, 12, 13, 14 | engine, gate and selector leftovers | fixed in Ticket 3 |
| 10 | stale test title `security-plan.test.mjs:156` | fixed in Ticket 3 (U1) |
| 15 | reassess runs only when called | intended: `security-risk.md:101-104` |
| 16 | TAP pass needs a one-file command | intended: `security-risk.md:93-99`, reworded |
| 17 | input surfaces not stored | intended: `security-risk.md:89-91` |
| 18 | a surface kind that does not select the whole class leaves the alert open | intended: `security-risk.md:124-129` |
| 19 | suite flakes under load | own GitHub issue with evidence (decision 7) |
| 20 | `branch_per_wave` front matter | settled by the `CLOSED` event |
| 21 | AC8 plan size and helper timing | fixed and measured (decision 6) |
| 22 | no ADD_CONTROLS fixture | intended: sealed set not extended; covered by `security-plan.test.mjs:341,436` and `[S20]` |
| 23–26, 28 | CodeRabbit points on PR #47 | fixed in Step 0 |
| 27 | Markdown table warnings in the wave-c2 plan | intended: inside that plan's approved digest |
| 29 | PR #46 path fix not exercised on Windows (tests skip there) | recorded limit |
| 30 | backdated START; auto-update makes in-flight runs stale | intended: Wave B plan open risks, `security-risk.md:157-159` |
| 31 | agent blindness and local-only inputs not verifiable | recorded limit: `effectiveness/REPORT.md` Limits |
| 32 | directory-level surface gives no file status | documented in Ticket 3 (U4) |
| M1 | selector picks 22–25 of 25 controls on StoreCraft | handed to the next enhancement as its first requirement (decision 3) |
| M2 | catalog gaps from the measurement, finding F21 | handed to the next enhancement (decision 8) |
| M3 | business-logic checks untested outside StoreCraft | handed to the next enhancement: audit another product with the Cloudflare audit skill, then score (decision 4) |

## Verification
Per PR: failing-first evidence for each fix; `cd skills/ship-ticket/scripts && node --test` (rerun a failing file alone before calling it a regression); `ENGINE_SECURITY_MUTATION=1 node --test engine-security-mutation.test.mjs`; `node --test skills/vapt/controls.test.mjs skills/vapt/fixtures.test.mjs skills/vapt/effectiveness.test.mjs`; `node scripts/cli.mjs validate`; frozen: `skills/vapt/controls.json`, `skills/vapt/controls.mjs`, `skills/security-audit`; CI green on all 9 jobs; Opus review + second opinion.

## State for resuming (after a compaction)
- PR #46 branch `fix/AIS-HARNESS-4-wave-b-followup` at 40c8051 (worktree `<scratchpad>/wt-followup`); PR #47 branch `feat/AIS-HARNESS-4-wave-c2-effectiveness` at eab75a9 (main checkout). Both CI green. CodeRabbit on #47: CHANGES_REQUESTED (the Step 0 points).
- Issue #45 holds the pre-registration hashes (3 posts). Stale branch `feat/AIS-HARNESS-4-wave-b-security-plan` still exists locally and on the remote.
- Scratchpad `/private/tmp/claude-501/-Users-ahmedabdelfatah-Documents-personal-projects-AI-Skills/76f21e3d-be67-4ffb-852b-74bbf1778a75/scratchpad`: `run/` (local-only writer and judge inputs and outputs), `markers/` (review results), `merge.mjs`, `input-hashes.txt`.
- Plans on their branches: `.specs/plans/AIS-HARNESS-4-wave-c2.md`, `.specs/plans/AIS-HARNESS-4-wave-b-followup.md`. Run ids: wf-1794300183 (C2), wf-1794300805 (follow-up).
- `.claude/` is untracked local settings: never commit or delete it.

<!-- RUN-STATE:BEGIN -->
{"event":"START","run_id":"wf-closure-1794310000","approved_plan_digest":"sha256:74b03b235e1f12c7715119e3181d8cbe7e6d9e3d358d492a3c86b305ebcd3d45","digest_procedure":"sha256 of the plan file with the text between the RUN-STATE markers removed (markers kept adjacent)","approved_via":"ExitPlanMode (2026-11-10), after the owner answered four questions in chat","recorded_at":"2026-11-10T11:10:22.819Z","base":"main@0eb0e49","scope":"closing pass: Ticket 3 hardening on this branch; Ticket 4 closing record on its own branch"}
{"event":"STEP0_DONE","run_id":"wf-closure-1794310000","what":"PR #47 touch-up reviewed (ais4c2-review-2 PASS) and CI green on d1dfaca; PR #46 squash-merged as 5a3793c, PR #47 as 0eb0e49, both by the orchestrator on the owner's answer \"Yes, merge both\"","recorded_at":"2026-11-10T11:10:22.819Z"}
{"event":"CONTRACT_EXPANSION","run_id":"wf-closure-1794310000","path":"skills/ship-ticket/references/plan.md","why":"decision 6 (three-line small-fix security section) made its \"one line\" sentence wrong","authorized_by":"owner (question dialog, 2026-11-10: \"Yes, fix the sentence\")","recorded_at":"2026-11-10T11:47:27.637Z"}
{"event":"RED","run_id":"wf-closure-1794310000","node":"U1 selector","evidence":"failing-first output for items 3, 7a, 1+4 (pins), 13, 21, 10 kept in the scratchpad marker cl-u1.red.txt; on HEAD a re-pathed approved boundary id came back UNCHANGED","recorded_at":"2026-11-10T11:47:27.637Z"}
{"event":"RED","run_id":"wf-closure-1794310000","node":"U2 gate","evidence":"failing-first output for items 5, 7b, 8, 9, 11 and the backslash file argument kept in cl-u2.red.txt","recorded_at":"2026-11-10T11:47:27.637Z"}
{"event":"RED","run_id":"wf-closure-1794310000","node":"U3 engine","evidence":"failing-first output kept in cl-u3.red.txt: before the fix a proof that rewrote the catalog got ship_ready, and a plan with a surface outside every node's writes bound at init","recorded_at":"2026-11-10T11:47:27.637Z"}
{"event":"BUILD_NOTES","run_id":"wf-closure-1794310000","notes":["U1: a standalone reassess whose inventory omits the approved surfaces and raises a fact now returns ADD_CONTROLS (owner addendum needed) where it returned the refusal control_unpaired: the helper unites the approved surfaces itself, so both callers get the same answer; the engine path never reached that refusal","U1: normPath no longer converts backslashes, so a contract path pattern with a backslash matches nothing and leads to REAPPROVAL","U2: an unlocated jest or vitest result from a command with an option off the allowlist (for example --json) is now missing; located results are attributed as before","U2 found and fixed in scope: a file argument with a backslash attributes nothing","U3: the S13 mutant text was retargeted because bindSecurity now takes the DAG nodes","join: U2 test tags renumbered to S32, S33, S34, S35, S37; 39 mutants in total; security-plan.test.mjs added to the mutation test list","docs (U4) written by the orchestrator: security-risk.md, plan.md (one sentence), validate.yml permissions"],"recorded_at":"2026-11-10T11:47:27.637Z"}
{"event":"REVIEW","run_id":"wf-closure-1794310000","review_execution":"ais4cl-review-1","ticket":"Ticket 3 hardening","profile":"ELEVATED","candidate_id":"9cf625135409b34188572aa2e8db820f3e3a97d349455b6379acc9a89a5fb2b5","primary":"opus","second_opinion":"coderabbit 0.7.6 (codex quota back 2026-11-11): 1 minor, the same as m1","outcome":"PASS","findings":{"blocker":0,"major":0,"minor":5},"note":"reviewer reverted seven fixes one at a time in scratch copies and each tagged test failed for the intended reason; both declared loosenings judged safe","recorded_at":"2026-11-10T12:22:19.520Z"}
{"event":"REPAIR","run_id":"wf-closure-1794310000","review_execution":"ais4cl-review-1","phase":"REVIEW","batch":1,"candidate_id":"2eac37320bb354c97b84672b679269b9269a7f41d1caeda0725886ce1556a978","fixed":["m1: init refuses security_pairs_mismatch when the reassess of the approved block is refused (test and mutant S40)","m3 and m4: two sentences in security-risk.md corrected","m5: spacing","m2: no code change; stated in the PR that the stricter path matching and the subtest-name unescape also apply to RED matching of runs without the security policy"],"rerun":["whole engine suite 556 tests, 554 pass, 0 fail, 2 skipped","vapt tests 191 pass","mutation suite: 40 of 40 mutants caught","node scripts/cli.mjs validate pass"],"second_opinion_before_confirmation":"coderabbit: 0 findings","recorded_at":"2026-11-10T12:22:19.520Z"}
{"event":"CONFIRM","run_id":"wf-closure-1794310000","review_execution":"ais4cl-review-1","candidate_id":"2eac37320bb354c97b84672b679269b9269a7f41d1caeda0725886ce1556a978","reviewer":"opus","outcome":"PASS","note":"m1-m5 fixed, nothing new; valid plans still bind (S13 real and empty selection, a probe with unknown facts and a 40-seed fuzz)","recorded_at":"2026-11-10T12:22:19.520Z"}
{"event":"SHIP_READY","run_id":"wf-closure-1794310000","ticket":"Ticket 3 hardening","candidate_id":"2eac37320bb354c97b84672b679269b9269a7f41d1caeda0725886ce1556a978","not_verified":["behaviour on a real Windows machine before CI (the Windows rows are canned and run on every OS)","node 18 file URL locations (canned rows)","preloads through NODE_OPTIONS in the engine environment (documented limit)"],"recorded_at":"2026-11-10T12:22:19.520Z"}
{"event":"MERGED","run_id":"wf-closure-1794310000","ticket":"Ticket 3 hardening","pr":48,"merge":"77f5c44","ci":"8 checks green on 203189c","authorized_by":"owner (question dialog, 2026-11-10: \"Yes, merge it\")","recorded_at":"2026-11-10T12:38:48.837Z"}
{"event":"CONTRACT_EXPANSION","run_id":"wf-closure-1794310000","ticket":"Ticket 4 closing record","path":"skills/ship-ticket/scripts/security-plan.test.mjs","why":"two acceptance criteria (AC2 no keyword-only rule, AC3 nothing written when a re-check finds no change) had no test of their own; test code only","authorized_by":"owner (question dialog, 2026-11-10: \"Yes, add both tests\")","recorded_at":"2026-11-10T12:38:48.837Z"}
{"event":"TICKET4_NOTES","run_id":"wf-closure-1794310000","notes":["closing record .specs/reviews/AIS-HARNESS-4/closure.md written by the orchestrator; every cited test name checked by grep","CLOSED event appended to .specs/plans/AIS-HARNESS-4.md (approved digest unchanged)","helper timing: 20 fresh-process runs each, median 26 to 28 ms (machine not idle)","issue #49 opened for the engine suite failing under load, with the failing test names from a deliberate four-copy run","issue #45 closed with a pointer to the merged report","merged branches of all waves deleted after checking each equals its merge commit"],"recorded_at":"2026-11-10T12:38:48.837Z"}
{"event":"REVIEW","run_id":"wf-closure-1794310000","review_execution":"ais4cl-t4-review-1","ticket":"Ticket 4 closing record","candidate_id":"3add2ca181ee2fc4349dd7969019225e924ff6cdf18379a1585c01c95d0baade","primary":"opus","second_opinion":"coderabbit 0.7.6: 1 minor (branch-cleanup wording)","outcome":"FAIL","findings":{"blocker":0,"major":1,"minor":5},"note":"major: a hand-over line stated a development result as general and dropped the in-sample label; reviewer verified every PR, merge commit, number, cited test name, the inventory, housekeeping, the CLOSED event and the plan digest","recorded_at":"2026-11-10T12:44:53.356Z"}
{"event":"REPAIR","run_id":"wf-closure-1794310000","review_execution":"ais4cl-t4-review-1","phase":"REVIEW","batch":1,"fixed":["M1 hand-over line now carries the label, the inputs as they were and the public median","m1 AC7 marked \"met as amended\" (ablation in place of hold-out)","m2 AC3 proof stated as the helper only; the engine appends one event and has no file-snapshot test","m3 \"that both judges accept\" restored","m4 \"each code fix with a failing test first\"","m5 direct forged-waiver test cited","CodeRabbit: branch-cleanup sentence says what was checked"],"rerun":["node --test skills/ship-ticket/scripts/security-plan.test.mjs 43/43","node scripts/cli.mjs validate"],"recorded_at":"2026-11-10T12:44:53.356Z"}
{"event":"CONFIRM","run_id":"wf-closure-1794310000","review_execution":"ais4cl-t4-review-1","candidate_id":"b35cf7dbec4eaf806fcfebdf36e28e3cf77d578d0795f10f7d5aff5ca22f0c33","reviewer":"opus","second_opinion":"coderabbit 0.7.6 on the repaired record: 0 findings","outcome":"PASS","per_finding":"M1 and m1-m5 fixed","new_minor":[{"id":"n1","summary":"the AC3 sentence about gate reassess named only one of the places the engine records the reassessment"}],"recorded_at":"2026-11-10T12:48:45.999Z"}
{"event":"NOTE","run_id":"wf-closure-1794310000","what":"n1 applied after the confirmation under the owner's no-leftovers instruction: the sentence now names the state file, the engine log and the plan RUN-STATE. One sentence in closure.md; checked by the validator only; no further review.","candidate_id":"ff6a6ba9e84664d1f39b57a527643cf463782ff1f1ba55580a5a8424796cfc54","recorded_at":"2026-11-10T12:48:45.999Z"}
{"event":"SHIP_READY","run_id":"wf-closure-1794310000","ticket":"Ticket 4 closing record","candidate_id":"ff6a6ba9e84664d1f39b57a527643cf463782ff1f1ba55580a5a8424796cfc54","evidence":["node --test skills/ship-ticket/scripts/security-plan.test.mjs 43/43","node scripts/cli.mjs validate pass","every cited test name checked by grep and by the reviewer"],"not_verified":["the #39 and #40 branch-head match can no longer be re-checked: those branches are deleted"],"recorded_at":"2026-11-10T12:48:45.999Z"}
<!-- RUN-STATE:END -->
