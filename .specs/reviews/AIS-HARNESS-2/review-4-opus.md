OUTCOME: FAIL

# ais2-review-4: Opus primary, the targeted confirmation of the class-wide REPAIR

- **Reviewer:** claude-opus-5.5, independent primary reviewer. Read-only: I made no repo edits, commits or pushes.
- **Candidate:** HEAD 71e3e6e, candidate_id 149d972be2183085d27df277f359021c6ff59e3379b0436daf38c8a7f8eb2c78. Base origin/main, plan file excluded.
- **Method:**
  - I read engine-authority, engine-quiesce, run-engine, engine-attempts, engine-gates, gate (gateRed), engine-io (runner, appendRunStateOnce), launcher and carrier (workerRunStateAppend, runStateAppendOnly) against the review-3 findings.
  - I ran `run-engine-review4`, `run-engine-review3`, `run-engine-repair` and `gate.test.mjs` together: **115/115 pass** (49 s).
  - Mutation in a scratch copy (`scratchpad/r4/m1`): `mayRun := false`, so `through` advances while a worker is live. It is killed by H "worker still live at its first settle". 7 of the 8 H tests survive it, which is expected: only that row has a live attempt at an observation.
  - B1 below is demonstrated by a CLI end-to-end probe, `scratchpad/r4/m2/scripts/probe-cr-e2e.test.mjs`, which uses the real fixture and an unmodified engine copy. A pure-function probe, `scratchpad/r4/probe-cr.mjs`, supports it.
  - I tested whether the normal owner workflow reveals the hidden line. It does not: the Claude Code Edit tool preserves a lone CR byte-for-byte, and so does the engine's own `appendRunStateOnce`.

## Scoped items

| Item | Status | Evidence |
|---|---|---|
| review-3 B1(a): RED/proof runner forges RETRY | **closed** | `engine-authority.mjs:25-37`. A line first seen while `attempts.length > through` is untrusted. The runner attempt is durably pushed before release: `gate.mjs:188-191`, `engine-gates.mjs:106-108,112-114`. The post-command `observe()` (`run-engine.mjs:108`) classifies before `through` advances. `retryEvent` reads only `trustedEvents` (`engine-gates.mjs:49-52`). Tests: the H rows for the RED runner, the RED runner with timeout, and the proof runner. |
| review-3 B1(b): worker live at its first settle | **closed** | `worker_appends`/`appends_recorded` are gone (grep: 0 hits in non-test code). A `launched`/`unknown` attempt keeps `mayRun` true (`engine-authority.mjs:18,36`), so `through` does not advance across resume. A line appended later is tainted at the next `observe`. Test: H row 3, and the mutation above kills it. |
| Class 1: authority only via observeAuthority | **closed for the stated design, with one representation hole (B1, major, below)** | The only writer of `S.authority` is `observeAuthority`, called from `run-engine.mjs:80` (start and end of `locked`, and init `:204`). Consumers: START `run-engine.mjs:62` (trusted only, with state), RETRY `engine-gates.mjs:51`, DAG_BOUND only at init `:194` (no attempts exist). Exception paths: a throw inside `fn` skips the post-observe, but the attempt is already durable, so the next command's observe is tainted. Crash paths behave the same. |
| Class 2: retire() is the only path to terminal / lock release | **closed** | `delete S.locks` exists only at `engine-quiesce.mjs:46`. Every terminal status assignment follows a successful `retire`: `engine-attempts.mjs:145,190,193,202→204/207/212/216,223,237,312`, `gate.mjs:177,192`, `engine-gates.mjs:117`. The non-retire assignments are all LIVE (`unknown`/`intent`/`launched`/`running`): `gate.mjs:199,206`, `engine-gates.mjs:112,118`, `engine-attempts.mjs:291`, `engine-quiesce.mjs:43`. Guard: `run-engine.mjs:83-84` (`unretired`) on every commit, including gateRed snapshots through `deps.commit`. "No pid ⇒ never released" holds: release follows the pid commit (`engine-attempts.mjs:291-294`, `gate.mjs:206-208`, `engine-gates.mjs:112-114`), and the launcher exits 125 on EOF without the release byte (`launcher.mjs:26-29`). |
| review-3 M1: evidence committed before the binding re-check | **closed** | `gate.mjs:214-221`: verifyBinding runs before the final RED commit, and drift gives RED_DROPPED. `engine-gates.mjs:147-153`: `local_proof` is set only after verifyBinding and the candidate check. Test: "M1 …never commits", with a commit log over every dir-fsync. |
| review-3 T1: RED binding re-check untested | **closed** | `run-engine-review4.test.mjs:234-248`, rows for the narrative and the DAG. It asserts that no committed state ever held `gates.red.r`. |
| review-3 F1: flaky dispatch-loop test | **closed** | `run-engine-review3.test.mjs:317-334`. `a` is released from a hook that fires only once `c` is `exited` in committed state. There is no timer, so the ordering is causal, not wall-clock. |
| RED runner exception path | **closed** | `gate.mjs:209-213`: catch, then `finish`, then retire, otherwise `unquiet` (`unknown`, locks kept). Tests: the Q rows, for both the unknowable and the killed-and-awaited cases. |

## New findings

### B1: major. Security, so it blocks under the plan's ship threshold. A worker can plant a RETRY that the engine cannot see now and will trust later, using a lone CR (`\r`) inside RUN-STATE

**Mechanism.** The engine's line splitting is not the same as the splitting the tools that later rewrite the plan use.

- `runStateEvents` (`engine-dag.mjs:37`) and `workerRunStateAppend` (`carrier.mjs:410`) split on `/\r?\n/`. A lone `\r` is therefore not a line break to the engine.
- A worker appends one line: `{"event":"NOTE","run_id":"run-1"}\r{"event":"RETRY",…,"authorized_by":"owner"}`.
- `workerRunStateAppend` cannot parse the line. Its parse failure returns `false` ("not authority"), so the append is exempt from ownership. It is recorded as an ordinary verified `PLAN_APPENDED`, with no violation and no judgment.
- `runStateEvents` drops the line because it is not valid JSON. `observeAuthority` therefore never classifies it: it is neither untrusted nor trusted.
- The narrative digest is unchanged, because the line sits between the markers.
- Any later universal-newline rewrite of the plan turns the `\r` into a line break. Two examples:
  - Python text-mode read and write. I verified that `open(p).read()` maps `\r` to `\n`.
  - An editor that normalizes mixed EOLs on save.
- At the next command, `through` is current, so the now-visible RETRY is trusted on first observation. `gate review rx-2` is then accepted.

**Proof (end to end, CLI).** The probe is `/private/tmp/claude-501/-Users-ahmedabdelfatah-Documents-personal-projects-AI-Skills/6a0d2a76-3170-4806-8985-cba4e74bd55a/scratchpad/r4/m2/scripts/probe-cr-e2e.test.mjs`. It runs on an unmodified copy of HEAD's scripts, and it passes:
1. A RED spec appends the raw text `{"event":"NOTE",…}\r{"event":"RETRY",…}`.
2. `gate red` returns `red_accepted`, with no judgment and `authority.untrusted == []`, so the line was never classified. The engine's `runStateEvents` sees no RETRY.
3. `drive` runs, and `gate review rx-1` PASS is accepted. The lone CR is still present: the engine's writes preserved it.
4. An external `\r(?!\n)` → `\n` rewrite of the plan is made.
5. `gate review rx-2` returns **`review_accepted`** (exit 0).

A worker can plant the line the same way. It is then exempt from ownership, because `workerRunStateAppend` returns true. The pure probe (`scratchpad/r4/probe-cr.mjs`) shows this: `exempt: true`, narrative digest unchanged, 0 untrusted and 0 trusted, then 1 trusted after normalization.

**Severity: major.** The ship threshold makes it block anyway.
- The reveal needs a tool outside the normal workflow. I verified that the Claude Code Edit tool and the engine's own `appendRunStateOnce` both preserve a lone CR.
- Tools that do reveal it include:
  - a Python text-mode read and write (`open(p).read()` maps `\r` to `\n`; verified)
  - an editor that normalizes mixed EOLs on save
  - any universal-newline script
- Until the reveal, the line is invisible in practice. Claude's Read tool renders the line as `{"event":"NOTE"}{"event":"RETRY"}` on one row.
- It is a silent fail-open, not fail-closed:
  - an unparseable `{`-line in a dispatched append is classed as benign by the ownership check
  - it is invisible to `observeAuthority`
  - it becomes owner authority for a further review round once it is revealed.
- The brief says forgeable is not acceptable, and under the plan's threshold anything touching security blocks. So: **FAIL**.

**Fix shape:**
- Use one tokenizer for every RUN-STATE reader: split on `/\r\n|\r|\n/`, or better, refuse any `\r` not followed by `\n`, and any U+2028/2029, inside the block.
- A worker-inserted line that starts with `{` but does not parse, or that contains the text `"RETRY"`/`"START"`/`"DAG_BOUND"` in any form, is an ownership violation, not exempt. In `workerRunStateAppend`, the parse failure should return `true` (authority-suspect), not `false`.
- Optionally, record a digest of the RUN-STATE block bytes at each quiescent observation. A later change to bytes that already existed is then flagged as a judgment instead of yielding new trusted lines.
- Add an H row: a worker appends with a lone CR, the file is normalized between commands, and the result must be `retry_unauthorized`, or an ownership violation at the drive.

### m1: minor. After `mark failed->pending`, a node can re-dispatch beside its own `unknown` predecessor whose group is still alive

- `reconcile` (`engine-attempts.mjs:237`) never reports a worker in `unknown` status with a live or unknowable group as `live`.
- After `mark failed->pending` clears the node's `quiescence_unknown` judgment (`run-engine.mjs:279-280`), `drive` dispatches the node again.
- The old attempt's locks block only nodes that declare `resources`. A node with none runs a second writer over the same write set. The new attempt's `excluded` list holds only in-process `E.live` entries, so ownership attribution between the two writers is wrong.
- Authority stays safe, because `mayRun` keeps `through` held.
- This requires an explicit owner `mark` together with an unkillable or unknowable group. The Q-worker test covers only the case where the group is proven gone.
- Fix: in `reconcile`, set `live = true` when `E.alive(a.pgid) !== false` for an `unknown` worker, or refuse `mark failed->pending` while the node has a non-retired attempt.

### m2: informational. No migration for older state files

- `commit()` now throws `unquiesced_exit` for any terminal attempt without `quiesced: true`.
- A state file written by the review-3-era engine, with `exited`/`abandoned` attempts, can no longer be committed. Every command fails.
- The engine is new in this PR, so only development and test states are affected. Fix: `load()` stamps `quiesced` on legacy terminal attempts, or this is documented.

### Residual notes (not findings)

- The trust boundary is "code the engine dispatched". Code the engine did not dispatch can still write a RETRY between commands, and it is trusted. Examples: orchestrator-spawned reviewer or Codex agents, or a second ticket's engine running in the **same** work tree during a wave. This matches the accepted "orchestrator can write RUN-STATE" boundary. It is worth stating in the SKILL text if waves can share a work tree.
- A worker that writes `.git/config` (`core.fsmonitor`) could run code during the engine's own `git` calls with no attempt live. This is dominated by the out-of-scope "state file as trust boundary" item (`.git` is writable).

Out of scope, as briefed: N1, N2, N7, setsid escape and the state file as trust boundary.

## Counts

- blocker 0
- major 1 (B1: a lone-CR hidden RETRY, forgeable with an external EOL normalizer; security, so it blocks under the threshold)
- minor 1 (m1)
- informational 1 (m2)

All review-3 items (B1a, B1b, M1, F1, T1) are closed, and both class-wide structural fixes hold under adversarial reading, except the representation hole B1.
