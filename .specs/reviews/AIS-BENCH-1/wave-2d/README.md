# AIS-BENCH-1 Wave 2d: #49 residual, `engine-crash.test.mjs`

Test-only change. The files changed are `skills/ship-ticket/scripts/engine-crash.test.mjs` and `skills/ship-ticket/scripts/run-engine-review3.test.mjs` (test G, see the scope extension below); no engine or production module was touched.

## The failure

`exceptions: a crash at every boundary of the unit repair drive` failed under four concurrent copies of the harness suite with
`hit 41 (rename) neither crashed nor was absorbed`. The crashed run's trace had 28 boundary hits:
`temp-write temp-fsync rename dir-fsync` ×2, `after-intent after-spawn`, one save, `after-pid after-release`, then three saves.

## T1: what varied, and why

Method: a logging copy of the lane (in a scratch directory) recorded every reference drive's boundary sequence. For each crash point whose run did not crash, it also recorded the hits, attempt statuses, judgments and events. It ran in four settings:
quiet (3 references); CPU burners only (16 or 40 busy loops, with 4 or 8 probe copies: 36 references and every crash point); and the real load (4 copies of the harness file list plus 4 logging copies of the lane).

- **The reference sequence never varied.** All 39 drive references recorded in the quiet and CPU-burner runs were the same 42-name sequence (one distinct sequence). Under suite load, every lane whose reference was logged also had that same sequence: 17 records, one distinct. There are no polling or retry saves: the engine awaits the worker's exit and does not poll it. The plan's hypothesis that "polling saves shift k" was **not observed**.
- **CPU load alone did not reproduce it.** With 40 busy loops and 8 probe copies, every crash point was reached. The only no-crash cases were the five expected absorbed ones (`UNIT_CHECK_RETRY`).
- **Under 4-copy suite load it reproduced in every logging copy.** That run had 17 not-reached crash points, all with the same signature. The repair attempt `repair-urx-uA-1` was `timed_out`, the drive ended `judgment unit_review_terminal`, and the trace was exactly the 28-hit trace above.
  The fake repair worker had not even recorded its run (`runs.fixuA` absent) when the fixture's per-attempt budget, `timeoutMs: 10000` (`engine-test-fixture.mjs` default), killed it.
  The logging copies reported 23 `DIFFERENT` outcomes (5+8+4+6). 9 were printed, and all 9 had that one signature: `repairs: failed`, `used: 1`, `unit_review_terminal`, no `fixuA` run. These were crashes before the repair whose recovery drive then timed out the repair the same way. The other 14 were never printed, because two copies failed first on the violations assertion.
  Those two copies reported an oracle violation, `P8 drive-crash@32:rename` and `P8 drive-crash@33:dir-fsync` ("hold urx-uA-1 of uA outlived its cycle"). Their link to the repair-timeout path is consistent with the deterministic probe below, but unconfirmed. Backstop: none of the 8 four-copy runs of the final test had a violation or a `timed_out` attempt.
- **Why:** the 10 s timeout is configuration in the test fixture, not engine nondeterminism. A timed-out repair is handled as specified (failed, never retried automatically), and the drive legitimately takes a shorter path. The test treated that path as the reference path.
- **Not a production bug in the sense of the stop rule.** One related off-path observation is listed under "Open" below.

## T2: what changed

1. **Budget (the fix).** The lanes create their fixture with `timeoutMs: 120000` (`BUDGET_MS`) instead of the 10 s default. The value is a failure bound, not a wait: no case in this test waits for a timeout to fire. The whole file finishes in 64 to 73 s alone (no baseline was measured before the change).
2. **A timeout is a failure, never a result.** The reference, every crashed run and every recovery assert that no attempt is `timed_out`. If one is, the test fails naming the attempt and the budget, so a slow machine produces a clear message instead of a misleading "not absorbed" or `DIFFERENT`.
3. **Stable crash-point identity.** A crash point is keyed by boundary name and that name's ordinal (`rename[11]`), not by a global hit count. A hit of another name can no longer move it.
   The test also asserts that the hits before the crash equal the reference prefix, because name+ordinal alone cannot see a divergence made of identical save groups. It also asserts that every lane recorded the same reference keys, and that the crashed keys equal the reference keys, in order, each once.
4. **Three outcomes, from a flag.** The hook records the hit at which it threw. The outcomes are crashed, absorbed (fired with no error, and `UNIT_CHECK_RETRY` must be present) and not reached. A not-reached point can no longer fall into the "absorbed" branch.
5. **Retry once, only when not reached.** A crash point that was not reached is re-run once from the same prefix snapshot, after its pipes are closed and its process groups are gone. A second miss fails with the key, the full hit trace and every attempt's status. Retries are reported in the `t.diagnostic` line (`retried`).
   A `DIFFERENT` recovery outcome is never retried. Violations from a discarded run are kept and still fail the test.

The recovery oracle is unchanged: `summary`, `classify`, `shown`, `recoverAndFinish`, and the assertions that there are no violations and no outcome other than `equivalent` or `D6`.

## T3: proof

| Check | Result |
|---|---|
| `node --test skills/ship-ticket/scripts/engine-crash.test.mjs` alone, 3 runs | 6/6 pass each time (64 to 73 s). Drive: 42 points, 38 equivalent, 4 D6, 5 absorbed, `retried: []`. Gate: 14 points, all equivalent |
| Mutation A (temp copy of the scripts directory): a never-released attempt settled on recovery is marked `failed` instead of `pending` (`engine-attempts.mjs` settle, intent branch) | red, drive family, through `DIFFERENT` outcomes (`repairs: failed`, `unit_review_terminal`). Gate family green: that path has no attempt |
| Mutation R (temp copy of the test): crash point 9 keyed to a boundary that never occurs | red: `crash point 9 (no-such-boundary[1]) was not reached on two runs: <42-hit trace> \| attempts: …` |
| Mutation R2 (temp copy of the test): crash point 9 missed on its first run only | green, diagnostic `retried: ["9:after-intent[1] (42 hits)"]`: one retry, then the point crashed |
| Four concurrent copies of the harness file list, twice | see below |

### Four-copy runs

R2 and the serial run used the final bytes. The test file's header comment was edited while R1 was running (a comment-only change). Each round had four copies of the 31-file harness list (629 tests each) running concurrently. The machine was not otherwise idle: a local VM and a browser were up.

| Round | c1 | c2 | c3 | c4 |
|---|---|---|---|---|
| R1 | 628/629 | 628/629 | 628/629 | 628/629 |
| R2 | 629/629 | 629/629 | 629/629 | 629/629 |

- **The changed test passed in all 8 copies.** Every drive diagnostic was identical: 42 points, 38 equivalent, 4 D6, 5 absorbed, `retried: []`. The gate family passed in all 8.
- **The one R1 failure in each copy is another test,** outside this change: `G a throw inside the dispatch loop still waits for every running sibling before the lock is released` (`run-engine-review3.test.mjs`), `Missing expected rejection` (`EISDIR`). It passed 3 of 3 when run alone and in all R2 copies. Lead, not a finding: its duration was 12.1 to 14.0 s in the four failing copies and 9.0 to 9.4 s in the four passing ones, so it may be the same class of fixed 10 s fixture budget.
- **The whole harness list run alone after the four-copy rounds:** 629/629.
- `node scripts/cli.mjs validate`: all skills valid.

**Acceptance:** "0 failures in four copies, twice" is **not met** for the suite as a whole, because of test G in R1. It is met for `engine-crash.test.mjs`.

## Open (outside this change's ownership)

- **Repair timeout + crash (off the tested path).** This was probed deterministically: the repair worker blocks on a file that is never written, with `timeoutMs: 3000`. Crashes during the timed-out repair's settle commit and the commits after it make the oracle report `P8 hold urx-uA-1 of uA outlived its cycle` on the crashed `drive` check. After recovery, `held` is `[]`.
  Caveats: (a) on this path the uncrashed reference is not a fixed point. A plain `resume` + `drive` after it re-runs nodes `a` and `i` and spends one more, so the `DIFFERENT` rows the probe produced are not evidence of recovery divergence. (b) P8's "outlived its cycle" rule is a post-reconcile rule applied to a mid-command crash state. Whether that is an oracle over-reach or an engine ordering issue (the hold is released after the repair's failure is durable) is the owner's call. (c) The probe was incomplete: one lane stopped at point 16 on the 20 s `groupsGone` bound, because the blocked worker never exits.
  Repro: `twoUnitWorld('pass')`, `{ unitRecheckCeiling: 4, timeoutMs: 3000 }`, `drive`, `ufail uA`, then set `fixuA` behaviour `waitFor` to a missing file and run this test's lane loop.
- **Other suite tests that failed under load** in the T1 run (4 harness copies plus 4 extra probe copies, so heavier than the 4-copy check): `S1 one node completes with the smallest command count` (3 of 4 copies), `B a RED runner group that survives the kill is not exited` (2), `H a RETRY forged by a worker still live at its first settle` (2), `B1 a RETRY a worker hides behind a lone CR` (1), `a supplied second-opinion confirmation is honoured` (1). They were not owned by this change and were not investigated.
- **`G a throw inside the dispatch loop …`** (`run-engine-review3.test.mjs`) failed in all four copies of round R1 of the final four-copy check (see above). It is a new residual for #49 and was not investigated here.
- `groupsGone` keeps its fixed 20 s failure bound. It did not fire in any run of the changed test.

## Scope extension (owner-approved, still #49, test-only): tests G and S1

This section supersedes two entries above, which stay as history: "`G a throw inside the dispatch loop …` was not investigated" and "Acceptance … is not met … because of test G".

The only file changed in this section is `skills/ship-ticket/scripts/run-engine-review3.test.mjs`, in test G. `engine-bench.test.mjs` is unchanged; see S1 below for the reason. No engine, production or fixture module was touched, and `engine-crash.test.mjs` was not touched.

### Method

A scratch probe re-ran the G body and an S1-equivalent drive (the same `fixture` + `cli init` + `cli drive` path that `s1()` uses). For every run it logged the outcome, judgments, node states, every attempt's status and times, and the runs the fake worker recorded. It ran under real load: four copies of the 31-file harness list plus four probe copies.
- L1: probes started 20 s in, 25 iterations each.
- L2: S1 only, probes started at t=0, 40 iterations each.

### G: `a throw inside the dispatch loop still waits for every running sibling …`

- **Observed (L1):** 25 of 100 probe runs missed the `EISDIR`, and G failed in all four harness copies of both L1 and L2. All 25 misses had one signature: `a` and `c` were both `timed_out` at the fixture's default `timeoutMs: 10000`. `runs.log` recorded neither `a` nor `c`, so neither fake worker had even started its body. `c` therefore never created the usage directory, the release flag was never written, and `b` was dispatched afterwards and finished. `drive` resolved with `node_failed … timeout`, which is the bare `Missing expected rejection` in the suite.
  The misses came in bursts at the same wall-clock times across copies: iterations 0, 1, 6, 7 and 8 failed in all four probe copies, 9 and 10 in two, and 11 in one. `b` started 10.2 to 10.6 s after `a`, so the engine's timer, kill and commit ran on time. It then finished in under 1 s in about nine of the misses and never took more than 3.8 s. What stalled was the start of the two fresh workers, not the engine (see "Mechanism" below).
- **Mechanism (L3, measured):** L3 added a probe that builds a fresh fixture and times `bin/claude auth status --json` twice. It also times a plain `sh -c true` and `node -e ''`. Under the same load (4 harness copies plus 4 probe copies, 100 samples):

  | Exec | Median | p90 | Max |
  |---|---|---|---|
  | First exec of the freshly written `bin/claude` | 3285 ms | 11516 ms | 13639 ms |
  | Second exec of the same script | 27 ms | 45 ms | 113 ms |
  | `sh` | 4 ms | 8 ms | 17 ms |
  | `node` | 21 ms | 37 ms | 98 ms |

  The first exec was more than 3× the second in 100 of 100 samples. Quiet, it was 317 ms first and 28 ms second. The cost is therefore a **first-exec cost of a newly created executable script**, not general CPU or spawn starvation. It is consistent with macOS scanning new executables, and XProtect was among the top CPU users in the machine snapshots, but that is not proven.
  Every fixture writes a new `bin/claude`, so a test's first worker launch pays that cost. In G, both `a` and `c` are first launches.
- **Cause:** the same test-fixture budget as `engine-crash`: a 10 s per-attempt timeout that is configuration, not the behaviour under test. The test never relies on a timeout: `a` is released by `c`'s committed settle.
- **Change:**
  - **Budget:** the fixture config gets `timeoutMs: WORKER_FAILURE_BOUND_MS` (120 s, already exported by `test-wait.test-helper.mjs`).
  - **Order of assertions:** `drive` is captured instead of wrapped in `assert.rejects`. The test then asserts that no attempt is `timed_out`, naming each attempt and the bound, and then that the error code is `EISDIR`. If `drive` resolves, the message includes its judgments. This has the same strength as before.
  - **Kept as they were:** the three post-assertions (lock released, `a` done before the rethrow, `b` never ran).
- **Planted failures (temp copies of the scripts directory):**
  - **G-M1** (`dispatchNodes` `finally` no longer awaits `Promise.allSettled(running)`): red, `the running sibling settled and committed before the rethrow`, `'running' !== 'done'`.
  - **G-M2** (test copy with `timeoutMs: 2000` and `c` waiting on a file that is never written): red, `attempt(s) exceeded the … failure bound`, naming the `a` and `c` attempts. In this copy the message still prints 120000 ms, because it names the constant, not the mutated config.
- **Alone:** G passed 5 of 5 runs.

### S1: `one node completes with the smallest command count`

- **Observed failure** (earlier T1 run, and in L1 for the sibling `the scenario CLI prints one result per scenario …`, 2 of 4 copies, which runs the same `s1()`): `outcome: judgment`, `nodes: { a: pending }`, `writer_runs: 0`, one judgment, wall time 15.3 to 15.6 s.
- **Not a worker timeout:** a timed-out attempt is settled `failed`, never `pending`, and the S1 probe (260 runs under L1 and L2 load) never reproduced it.
- **Cause, matched to the signature by a deterministic repro (not observed directly under load):** `s1()` drives the real CLI (`fx.cli`), so `drive` runs the production subscription probe `verifySubscription` (`provider-env.mjs`). That probe spawns `claude auth status --json`, which is the fixture's `sh` → `node fake-claude.mjs`, with a **15 000 ms** timeout. That probe is the first exec of the fixture's freshly written `bin/claude`, so it pays the first-exec cost measured in L3 (up to 13.6 s there, and more in heavier bursts). When it passes 15 s, the engine correctly refuses with `billing_unverified` before dispatching anything.
  The repro was a scratch copy of the S1 path with the fake `claude` sleeping 16 s on `auth`. It produced exactly the suite signature: `{"ms":15439,"outcome":"judgment","nodes":{"a":"pending"},"judgments":[{"code":"billing_unverified",…}],"runs":0}`.
- **Why there is no change here:** nothing in `engine-bench.test.mjs` can reach this. `runScenarios(id, { buildNodes })` is its only input, `s1()` builds its world inside `engine-bench-scenarios.mjs`, the CLI path has no `verifySubscription` seam, and the 15 s bound is a production budget. A retry in the test would be blind, because `shows` does not carry judgment codes. This needs an owner decision outside this ownership (see "Open" below).

### Proof (final tree)

| Check | Result |
|---|---|
| G alone, 5 runs | 5/5 `ok` (name-pattern runs; the `ok … G a throw …` line was checked each time) |
| G-M1, G-M2 | both red, with the messages above |
| Four concurrent copies of the 31-file harness list, R1 | c1–c4: 629/629 each |
| Four concurrent copies, R2 | c1–c4: 629/629 each |
| `node scripts/cli.mjs validate` | all skills valid |
| S1 alone, 3 runs | 3/3 `ok` (no change to its file; recorded as the baseline) |
| L3: G probe body with the new 120 s bound, under 4 harness copies plus 4 probe copies | 100/100 `EISDIR`, 0 `timed_out`. In **20 of 100** runs an `a`/`c` attempt ran longer than 10 s (maximum 14.6 s): each of those would have been killed by the old bound, so the change was exercised, not just lucky. The S1 probe was 100/100 `done` |

In the four-copy rounds, G took more than 10 s as a whole test in 6 of 8 copies (7.9 to 12.0 s). That is wall time including setup, so it is supporting evidence only; L3 above is the direct evidence.

- **Positive signal:** in each of the 8 copies, the `ok` lines for G, S1, `the scenario CLI prints …` and the `engine-crash` drive test were each present once. Each copy ran for about 364 to 372 s.
- **Machine state** (recorded at each round start): at R1 the load average was 5.05; a local Docker VM was using 140 % CPU, plus Docker Desktop at 76 % and XProtect at 32 %. At R2 the load average was 12.93 (the R1 tail), with Storage and WindowServer busy. The machine was not idle.
- **Lighter than the diagnosis runs:** the four-copy rounds carried less load than L1 and L2, which also ran four probe copies. S1 passing all 8 copies does **not** show that S1 is fixed: its cause is unchanged.

### Open (outside this ownership)

- **S1 / `the scenario CLI prints one result …`:** both remain exposed to the 15 s production subscription-probe timeout under spawn starvation. The options all need someone other than this builder:
  1. **Fixture warm-up (candidate, not proven under load):** `engine-test-fixture.mjs`, or `world()` in `engine-bench-scenarios.mjs`, executes the new `bin/claude` once, with no timeout, before handing out the fixture. The first-exec cost is then paid outside the production 15 s probe; L3 measured second execs at 113 ms or less. Answering `auth` inside the `sh` wrapper would **not** help, because the stall is the script's own exec.
  2. **Scenario diagnostics:** `engine-bench-scenarios.mjs` adds judgment codes to `shows`, so a failure names `billing_unverified` instead of `a: pending`.
  3. **Owner decision:** whether the bench should treat an environment refusal differently. The 15 s production budget stays as it is.
- **The L3 harness copies** (on the final tree, with probes alongside) failed: `the scenario CLI prints one result …` (1 of 4 copies), `AC4 …` (2), `launcher: a provider that exits 0 while a descendant holds stdout …` (2) and `B1 … U+2028 …` (1). G passed in all four.
- **Other tests that failed under the heavier L1 and L2 load** (4 harness copies plus 4 probe copies). None of them failed in the two plain four-copy rounds. They were not investigated:
  - `H a RETRY forged by a worker that times out …` (3 of 4 copies in L1)
  - `AC4 an engine crash before release never runs the worker …` (3 in L1, 1 in L2)
  - `R14 a snapshot git cannot produce is ownership_unavailable …` (1 + 1)
  - `CodeRabbit 4513255398: a failed archive leaves no numbered directory behind` (3 in L2)
  - `B1 a RETRY a worker hides behind U+2028/U+2029 …` (1 + 1 in L1, 1 in L2)
  - `B a proof runner whose process group cannot be proven gone …` (1)
  - `launcher: a provider that exits 0 while a descendant holds stdout …` (1)

- Repair batch (review findings): `engine-crash.test.mjs` now asserts the discarded first run's timed-out attempts are empty before the retry; test G's timeout message in `run-engine-review3.test.mjs` is neutral about slow machine versus a release that never happened; the opening line above lists both changed files.
