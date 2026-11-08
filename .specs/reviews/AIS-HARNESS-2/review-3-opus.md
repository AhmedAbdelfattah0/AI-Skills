OUTCOME: FAIL

# ais2-review-3: Opus primary, the targeted confirmation of the ais2-review-2 REPAIR

- **Reviewer:** claude-opus-5.5, independent primary reviewer. Read-only: I did not build this, and no repo edits, commits or pushes were made. `git status` shows only the pre-existing `?? .claude/`.
- **Candidate:** HEAD 7e90114, candidate_id 10963f5b8154a15db2d4ca79540f0bd61db00f6bfa43d3ef176c0dcd91c07b38. Base origin/main, plan file excluded.
- **Method:**
  - I read every scoped item against the code.
  - I ran `run-engine-review3.test.mjs`: 17/17 pass, 29 s.
  - I ran one-line mutations in a scratch copy of `skills/ship-ticket/scripts/` (`scratchpad/mut/scripts`), each with the matching tests. The harness is `scratchpad/mutate.mjs`.
  - I wrote two adversarial probe tests in the same scratch copy, each with a one-line fixture extension (`appendLate`) in the scratch copy of the fixture only.

## Scoped items

| Item | Status | Code evidence | Test discriminates? |
|---|---|---|---|
| N3: a provider-default builder vs same-provider reviewers | **closed** | `gate.mjs:281-289` (`builderOf`: a `<provider>:provider-default` builder matches every `<provider>:*` identity); used for primary `:307`, second opinion `:317` and confirmation `:375`. Builder identity comes from `engine-attempts.mjs:295-296`, `plan.model` = `'provider-default'` (`carrier.mjs:255`). | Yes. M1 (clause disabled) kills test A. |
| N4: a worker cannot forge RETRY/START/DAG_BOUND | **partial: NOT closed** (see B1) | Direct worker path: `engine-attempts.mjs:136-140` (`planAppendOnly` refuses `AUTHORITY_EVENTS`, so the append is an ownership or repair violation), `:128-134` (`recordAppends` → `worker_appends`), `engine-gates.mjs:48-53` (`retryEvent` skips recorded lines). START and DAG_BOUND forging has no effect after init: `verifyBinding` compares against the bound `S.plan_digest` (`run-engine.mjs:101`), and DAG_BOUND is read only in `init` (`:173`). **Open:** a RED runner or proof runner (`engine-gates.mjs:26-45`, `:99-129`), and a worker that is still live at its first settle (`engine-attempts.mjs:210` before `:215`). | Partly. M2a (forged filter removed) kills both G forge tests; M2b (authority check removed) kills G1. Both open paths are untested. Both are reproduced by the probes below. |
| N5: an infra retry of a review repair is not refused as `round_limit` | **closed** | `engine-attempts.mjs:393` (`&& !r.round_held`), `:429-434` (the round is spent once; `round_held` is set at launch intent) | Yes. M3 kills G (infra retry). |
| N6: proof/RED runner quiescence proven before `exited` | **closed** | `engine-io.mjs:289-293` (`quiescent` is true only when `quiesce` returns false). RED: `gate.mjs:201-206` (status `unknown`, locks kept, `quiescence_unknown` judgment point). Proof: `engine-gates.mjs:113-120` (status `unknown`, durable judgment, no LOCAL_PROOF). `unknown` runners are reconciled at `engine-attempts.mjs:242-248,256` and block ship-ready at `gate.mjs:423`. | Yes. M4a (proof check), M4b (RED check) and M4c (io `quiescent=true`) are each killed by the B tests. |
| allSettled test gap (review-2) | **closed** | `engine-attempts.mjs:364-381` (`try/finally Promise.allSettled`) | Yes. M9 (finally emptied) kills G "a throw inside the dispatch loop". See F1 for its flakiness. |
| Codex: proof/RED runner quiescence (engine-gates) | **closed** | Same evidence as N6 | Yes (M4a-c) |
| Codex: approval digests rechecked after proof and RED | **closed in code. The RED half has no discriminating test.** | Proof: `engine-gates.mjs:144-154` (`verifyBinding` and a candidate re-check; the proof record is dropped). RED: `engine-gates.mjs:38-42` (evidence deleted, RED_DROPPED). | Proof: yes, M5 kills both C tests. **RED: no.** M6 (`unbound = []` after RED) survives `run-engine.test.mjs` (39/39), `run-engine-review3.test.mjs` (17/17) and `gate.test.mjs` (48/48). Its one "kill" in `run-engine-repair.test.mjs` was R17, which also fails unmutated in the scratch copy because that copy has no `.github/`. That is environmental. Test gap T1. |
| Codex: review-repair launch blocked on post-freeze drift | **closed** | `engine-attempts.mjs:409-416` (`startsFromFreeze`: current candidate == freeze == `r.old_candidate`), called at `:427` before budget and launch, so no round is spent | Yes. M7 kills D. |
| Codex: overflow FAIL is terminal without an explicit RETRY | **closed** | `gate.mjs:336-355` (overflow → `review_terminal`, `judgment_point`, no `repair`, `write_set: []`); `engine-gates.mjs:74-90` records it and freezes it; confirmation → `chain_broken` (`gate.mjs:371`); ship-ready → `review_not_accepted`. Carrier REPAIR also refuses: `carrier.mjs:151-152` requires a non-empty `write_set`, and a terminal record has `[]`. | Yes. M8b (terminal return disabled) kills both E tests. M8 (`!overflow` removed from `repairs`) survives, but it is an equivalent mutant: the `if (overflow) return` at `:352` fires first. This is not a gap. |

Out of scope, as briefed: N1, N2 and N7.

## New findings

### B1: blocker. A dispatched agent can still forge the owner's RETRY authorization. Review integrity; incomplete closure of N4.

`retryEvent` (`engine-gates.mjs:48-53`) honours any RUN-STATE `RETRY` line in the plan file that is not in `state.worker_appends`. Lines get into `worker_appends` only through `recordAppends` on worker attempts. Two paths therefore write a RETRY that the gate later honours.

**(a) Runner-executed code. This path is silent.**
- `gate red` runs the RED specs, which are test files a builder node wrote. The proof at ship-ready runs `testCommands` over code the builders wrote.
- Neither runner path compares the plan's RUN-STATE before and after the run.
- The post-RED and post-proof `verifyBinding` (`engine-gates.mjs:38`, `:145`) checks only the narrative digest and the DAG bytes. RUN-STATE is outside the narrative by design.
- Result: no judgment, no event and no `worker_appends` entry.
- Reproduced by `/private/tmp/claude-501/-Users-ahmedabdelfatah-Documents-personal-projects-AI-Skills/6a0d2a76-3170-4806-8985-cba4e74bd55a/scratchpad/mut/scripts/probe-red.test.mjs`:
  1. A spec file appends `{event:'RETRY', review_execution:'rx-2', predecessor:'rx-1', authorized_by:'owner'}`.
  2. `gate red` returns `red_accepted`.
  3. `drive` succeeds and review `rx-1` passes.
  4. `gate review rx-2` (a new original) returns **`review_accepted`** (exit 0), although no owner wrote a RETRY.

**(b) A worker that is live when it is first settled.**
- `settle()` calls `recordAppends` (`engine-attempts.mjs:210`) before the `'live'` return (`:215`). That sets `a.appends_recorded = true`, which is committed.
- An append the worker makes afterwards is never recorded: the final settle returns early at `:129`.
- `changes()` still flags the plan file as `ownership_violation`, but the forged line is honoured by `gate review`.
- `gate review` does not check `S.judgments`. After `mark failed->pending` clears the violation, the run proceeds normally.
- Reproduced by `/private/tmp/claude-501/-Users-ahmedabdelfatah-Documents-personal-projects-AI-Skills/6a0d2a76-3170-4806-8985-cba4e74bd55a/scratchpad/mut/scripts/probe-forge.test.mjs`:
  1. Start `drive`, then SIGKILL the engine while the worker waits.
  2. `resume` reconciles the attempt as live (`appends_recorded: true`).
  3. The worker appends RETRY and exits.
  4. `drive` returns `ownership_violation` with `worker_appends: []`.
  5. `mark failed->pending`, `drive`, then `rx-1` PASS.
  6. `rx-2` returns **`review_accepted`**.

**Why this blocks:**
- The review-3 test header states the contract this repair claims: "gate review never honours a RETRY that a worker appended". The repair's RETRY scope includes "worker cannot forge RETRY".
- Path (a) needs no crash. The builder only has to write a test file, which is its job under RED-first. The forgery then leaves no trace anywhere.
- The prior N4 was rated minor because the orchestrator could already write RUN-STATE. This is different: a dispatched agent escalates to *owner* authorization of a further review round, through the engine's own runner.
- Under the owner's ship threshold ("anything touching data integrity, security, tenancy or money blocks"), I read a forgeable review-authorization gate as security. The owner may override that reading explicitly.

**Fix shape:**
- (b): set `appends_recorded` only on a final settle, not on the `'live'` return. Or make `recordAppends` idempotent per line and run it on every settle.
- (a): give RED and proof runners the same plan before/after append recording. Any `AUTHORITY_EVENTS` append during a runner drops the RED or the proof, records the line in `worker_appends`, and raises a judgment.
- Stronger, and it closes both paths and any future runner: honour only RETRY events the engine itself recorded under the lock, for example via a CLI command that writes the RETRY with an engine-issued `event_id` into state. A line's content in the plan file is then never authority on its own.

### T1: test gap (minor). No test covers the RED-path binding re-check

M6 survives (see the table). `engine-gates.mjs:38-42` is correct by reading but unprotected. Add a CLI test in which the RED runner edits the plan narrative or the DAG and expect `approval_mismatch`/`dag_mismatch`, `RED_DROPPED` and no `gates.red[node]`.

### M1: minor. Crash windows: evidence is persisted before the binding re-check

- `gateRed`'s final `deps.commit` (`gate.mjs:231`) persists `gates.red[node]` before `engine-gates.mjs:38` re-checks the binding.
- `runProof` commits `local_proof` with the candidate (`engine-gates.mjs:126-127`) before `:145`.
- A crash between the commit and the check leaves the evidence on disk.
- Persistent drift is still caught: every later gate starts with `verifyBinding` (`run-engine.mjs:280`). Drift that the runner reverts before exiting is undetectable in any case.
- Fail-closed in practice. Fix: re-check the binding before the final commit.

### F1: flaky test, identified by reading (minor, test-only)

**The test:** `run-engine-review3.test.mjs:316` "G a throw inside the dispatch loop still waits for every running sibling…". Its outcome depends on a wall-clock race.

**How it is meant to run:**
- Node `c` must create the usage path as a directory, so that the next `budgetOk` read throws EISDIR.
- That must happen before node `a` is released.
- The release is a flag written 1500 ms after `c`'s `after-release` (`:326`).

**How it flakes:**
- If `c`'s fake-CLI process has not written within 1.5 s, `a` finishes first.
- The loop then re-scans with `c` still running, `budgetOk(b)` passes, and `b` fits beside `c` (width 2), so `b` is dispatched.
- `fx.runs('b').length === 0` (`:331`) fails, and usually `assert.rejects` fails too, because no later `budgetOk` call happens.
- That fits "1 failure in ~11 full-suite runs": the parallel suite spawns many node and git processes per file.

**Fix:** release `a` from `c`'s completion, for example a `waitFor` on a file that `c` writes, instead of a timer.

## Not re-opened

- N1, N2 and N7 (follow-ups, per the brief).
- Reviewer identity is self-declared text. An alias such as `opus` never matches `claude:...`. This was out of scope in review-2.
- `.git`-resident engine files (the state, the attempts dir, `plan_before_file`) are writable by a worker without showing in `git status`. That is equally true of the state file itself, a known trust boundary.

## Counts

- blocker 1 (B1)
- major 0
- minor 2 (M1, F1 flaky test)
- test gap 1 (T1)

All scoped items except N4 are closed in code, and each closure is killed by a one-line mutation, except the RED half of the binding re-check (T1).

**The FAIL rests on B1.**
