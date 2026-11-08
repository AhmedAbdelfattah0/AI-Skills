OUTCOME: FAIL

# ais2-review-5: Opus primary, the targeted confirmation of the review-4 repair

- **Reviewer:** claude-opus-5.5, independent primary reviewer. Read-only: no repo edits, commits or pushes.
- **Candidate:** HEAD 6137c9a, candidate_id 31856a0bbb192b1f0e38774c0979160c4e4603be707b065838c266543defe398. Base origin/main, plan file excluded.
- **Method:**
  - Read the repair diff (`git diff 71e3e6e HEAD`): run-state.mjs (new), engine-authority, engine-attempts (reconcile), run-engine (load/approvedPlan/verifyBinding), carrier (verifyApproval, re-exports), engine-dag, engine-io (appendRunStateOnce/eventLine), fixture, review5 tests.
  - Suites: `run-engine-review5`, `-review4`, `-review3`, `-repair`, `run-engine`, `gate`, `carrier-usage` together: **207/207 pass** (54 s).
  - Pure probe of 18 hiding tricks against `parseRunState`/`workerRunStateAppend`/`observeAuthority`: `scratchpad/r5/probe.mjs`, `scratchpad/r5/probe2.mjs`.
  - End-to-end CLI probe of the new finding on an unmodified copy of HEAD's scripts: `scratchpad/r5/scripts/probe-dupend-e2e.test.mjs` (worker, 2/2 pass = attack succeeds), `probe-dupend-red.test.mjs` (RED runner, full reach), `probe-dupend-proof.test.mjs` (proof runner).

## Scoped items

| Item | Status | Evidence |
|---|---|---|
| review-4 B1: lone CR (and other hidden line breaks) hides an authority line | **closed as filed** | One splitter, Python `splitlines` set: `run-state.mjs:17,22`. Hidden break detection: `run-state.mjs:18,24,44`. A malformed block (hidden break or unparsed `{` line) taints every line first seen with it: `engine-authority.mjs:32`, and refuses every mutating command: `run-engine.mjs:61-62,130`, carrier `verifyApproval` `carrier.mjs:123-125`. A rewrite of already-observed block bytes taints too: `run-state.mjs:51`, `engine-authority.mjs:31,41`. Worker exemption: a hidden break or an unparsable brace line is never exempt, and inserted text is read from the start of its line: `run-state.mjs:76-85`. Engine's own writer escapes U+0085/2028/2029: `run-state.mjs:26`, `engine-io.mjs:186`. Probe: lone CR, NEL, U+2028/2029, CRLF, BOM, NBSP, NUL (prefix and inside), ZWSP, fullwidth brace, `x`-prefix, HTML-comment wrap, duplicate JSON key, tabs, trailing spaces, backslash continuation, duplicate BEGIN: **none yields a trusted RETRY**; every byte-stripping reveal is caught by the `blockExtends` rewrite taint. Tests: the 8 B1 rows + the brace-line row in `run-engine-review5.test.mjs:105-129`. |
| B1 "every RUN-STATE reader goes through run-state.mjs" | **closed** | Remaining `/\r?\n/` or `'\n'` splitters are not RUN-STATE: `carrier.mjs:92` (git rev-parse stdout), `carrier.mjs:157` (run-log JSONL), `carrier.mjs:424` (provider stdout), `gate.mjs:27` (TAP), `engine-io.mjs:175` (engine log), `engine-attempts.mjs:42` (usage JSONL), `docker-lifecycle.mjs`, `usage.mjs`, `eval.mjs`. `engine-dag.mjs` and `carrier.mjs` re-export from run-state.mjs. Only the test fixture's own `runStateEvents` (`engine-test-fixture.mjs:191-193`) splits on `'\n'`, test-only. **But** marker location is not single-sourced in the authority sense: see R5-B1 below. |
| review-4 m1: re-dispatch beside a live `unknown` predecessor | **closed** | `engine-attempts.mjs:236-238`: an `unknown` worker is retired (group killed and proven gone) or reported `live`; `drive` dispatches nothing (nodes or repairs) while `live` (`run-engine.mjs:249-252`). `mark` cannot run concurrently (ticket lock). Tests: `run-engine-review5.test.mjs:151-168`. |
| review-4 m2: legacy state | **closed** | `run-engine.mjs:80-83`: `load()` refuses with `legacy_state` and an instruction; covers `drive`, `status`, `resume`, `mark`, `gate` (all go through `load`). Test `run-engine-review5.test.mjs:172-181`. |
| review-3 quiescence / authority guarantees (no regression) | **holds** | `retire()` is still the only terminal path (`engine-quiesce.mjs:41-48`); `commit()` guard unchanged (`run-engine.mjs:90-91`); `through` advances only with no `mayRun` attempt (`engine-authority.mjs:20,42`); classification happens before `through` advances (`engine-authority.mjs:32` vs `:42`). review-3/review-4 suites pass. |
| TOCTOU between observation and use | **no new hole found** | Observation and use run under the ticket lock; any dispatched code that could write between the pre-`fn` observe and a later read is a durable attempt, so `attempts.length > through` taints it (`engine-authority.mjs:32`). Residual (unchanged from review-4): non-dispatched writers (a second ticket's engine in the same work tree, orchestrator-spawned agents). |

## New findings

### R5-B1: major. Security, so it blocks under the plan's ship threshold. A worker hides a RETRY behind a stray END marker; removing the marker reveals it as trusted

**Mechanism.** The repair closed hidden *line breaks*, but not hidden *block boundaries*. `parseRunState` takes the **first** BEGIN and the **first** END (`run-state.mjs:35-37`) and returns `null` when END is missing. Lines outside that span are never classified by `observeAuthority` (`engine-authority.mjs:30,33`), so a line dispatched code planted there is not recorded untrusted. When the stray marker is later removed, the block grows past its old end, `blockExtends` is true (`run-state.mjs:51`: the old prefix is unchanged), nothing is hidden or unparsed, `through` is current, and the RETRY is **trusted on first sight**.

Three variants (all verified):
1. Duplicate END line. The worker appends `<!-- RUN-STATE:END -->\n{"event":"RETRY",…,"authorized_by":"owner"}\n`. Not malformed (block is clean up to the first END). Cleanup = delete the stray END line → trusted.
2. END inside a JSON string. The worker appends `{"event":"NOTE","x":"<!-- RUN-STATE:END -->"}\n{RETRY}\n`. The engine reports `run_state_malformed` with the excerpt `{"event":"NOTE","x":"` and the instruction **"fix or remove it"** (`engine-authority.mjs:51`). "Fixing" it by deleting the marker text → trusted. (Deleting the whole line is caught as a rewrite; the engine's own message steers toward one of two edits, and one fails open.)
3. END removed. The worker replaces `END` with the RETRY line; `parseRunState` returns null, so nothing is classified and `A.block` is not updated (`engine-authority.mjs:41`). Re-adding the missing END after the RETRY → trusted (`probe2.mjs`).

**What the engine does see at plant time:** the worker's change is not an append-only change (`runStateAppendOnly` counts markers, `run-state.mjs:63-64`), so it is an ownership violation (`repair_outside_findings` in the probe), and the narrative digest no longer matches, so the next command reports `approval_mismatch`. That forces someone to edit the plan. The fail-open is that the engine discards what it knows (this text appeared while an attempt was live) and lets a partial cleanup turn it into owner authority.

**Proof (end to end, CLI, unmodified HEAD scripts):** `/private/tmp/claude-501/-Users-ahmedabdelfatah-Documents-personal-projects-AI-Skills/6a0d2a76-3170-4806-8985-cba4e74bd55a/scratchpad/r5/scripts/probe-dupend-e2e.test.mjs`. For variants 1 and 2: rx-1 FAIL → repair worker plants → `drive` exit 2 (ownership judgment), `authority.untrusted == []` → cleanup edit between commands → `resume` exit 0 → `gate review rx-2` → **`review_accepted`**, exit 0, with the forged RETRY in `authority.trusted`.

**Reach (what the forgery buys):** a review FAIL bypass with no durable trace. `/private/tmp/claude-501/-Users-ahmedabdelfatah-Documents-personal-projects-AI-Skills/6a0d2a76-3170-4806-8985-cba4e74bd55a/scratchpad/r5/scripts/probe-dupend-red.test.mjs` (variant 2, planted by a RED spec): `gate red` is refused (`run_state_malformed`), the next command repeats "…not JSON…; fix or remove it", the line is "fixed" by deleting the marker text, then `gate red` → `red_accepted`, `drive` → 0, `gate review rx-1` FAIL → accepted, **`gate review rx-2` PASS → `review_accepted` on the forged RETRY**, and `gate ship-ready` is refused only for `missing_local_proof` (the fixture has no proof command), with `judgments == []`. The worker variant leaves a durable `repair_outside_findings` judgment that blocks ship-ready (`gate.mjs:437`), but the RED-runner and proof-runner variants leave none (`probe-dupend-proof.test.mjs`: `ship_ready` after cleanup). So an unauthorized new original review replaces an accepted FAIL and the run can reach SHIP_READY.

**Severity: major.** Less likely than review-4 B1: it needs an owner or orchestrator edit, and the forged RETRY line is visible in the file. But that edit is the natural minimal repair of a stray marker or of the line the engine's own message tells the owner to "fix", an LLM orchestrator is a plausible editor, and it contradicts the review-5 contract ("a RETRY planted by dispatched code is never trusted, whatever later normalizes it", `run-engine-review5.test.mjs:15`). Security touching, so it blocks under the threshold.

**Fix shape (small):**
- In `parseRunState`, treat anything other than exactly one BEGIN and one END as malformed (`markers` flag), reported by `malformedRunState` as `run_state_malformed` and counted in `tainted` (`engine-authority.mjs:32`).
- In `observeAuthority`, classify authority lines over the widest span (first BEGIN to the **last** END, or to EOF when END is missing), so a line planted beyond a stray or removed marker is recorded untrusted while `attempts.length > through`, and stays untrusted after any cleanup (line identity is already sticky, `engine-authority.mjs:36`).
- Add review5 rows for the three variants (worker, RED runner, proof runner), each cleaned up between commands, expecting `retry_unauthorized`.

### R5-i1: informational. carrier `verifyApproval` refuses a hidden break but not an unparsed brace line

`carrier.mjs:125` checks `block.hidden` only; the engine also refuses `unparsed` (`engine-authority.mjs:48`). Not exploitable on its own (a later reveal is a rewrite), but the "one reader, one verdict" intent would put both checks in one place, e.g. `malformedRunState` in run-state.mjs.

### R5-i2: informational. Usability of the rewrite taint

Any whole-file normalization (CRLF→LF, an editor's EOL fix, which `run_state_malformed` itself asks for) marks the block rewritten, so an owner event appended in the same edit is untrusted and, because untrusted line identity is sticky, must be re-appended with different content in a later edit. The `retry_unauthorized` reason says this; the `run_state_malformed` message ("normalize the plan file, then re-append any owner event") should say "in a separate step, as a distinct line".

### R5-i3: informational. `reconcile` now kills `unknown` worker groups on every drive/resume

`engine-attempts.mjs:237` calls `retire()`, which SIGTERM/SIGKILLs `-pgid` (`engine-quiesce.mjs:15-22`), where it previously only waited for `alive === false`. An `unknown` attempt can stay on disk a long time, so a recycled pgid could make the engine signal an unrelated process group. Same pre-existing class as `settle`'s retire (pgid reuse), only with a longer window; within the setsid/out-of-scope family. No action required for this PR.

Out of scope, as briefed: N1, N2, N7 (including Windows `unknown` blocking dispatch forever), setsid escape, state file as trust boundary, carrier.mjs size.

## Counts

- blocker 0
- major 1 (R5-B1: stray/removed END marker hides a worker-planted RETRY; a partial cleanup reveals it as trusted)
- minor 0
- informational 3

review-4 B1 (as filed: hidden line breaks), m1 and m2 are closed; review-3 guarantees hold. The B1 class (dispatched code plants a line the engine cannot see, a later non-dispatched edit reveals it) remains open through the block markers.
