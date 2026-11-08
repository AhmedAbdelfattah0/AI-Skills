# ais2-review-1 — Codex second opinion (FAIL, overflow)

Candidate 57d8a0879f221b2570a38207488cfe71275dfb781e141ad95ce3ec74e4cc25c1 (HEAD 938eca4). Verbatim relay output.

**reviewer_identity:** Codex, independent read-only second opinion  
**candidate_id:** `57d8a0879f221b2570a38207488cfe71275dfb781e141ad95ce3ec74e4cc25c1` — reproduced exactly  
**outcome:** **FAIL**

**findings:**

1. **AIS2-01 · blocker · [run-engine.mjs:517](/Users/ahmedabdelfatah/Documents/personal-projects/AI-Skills/skills/ship-ticket/scripts/run-engine.mjs:517)**  
   **Evidence:** gate execution performs `E.load()` followed by candidate calculation, without checking approved-plan/DAG digests or matching `ctx.runId` against state.  
   **Consequence:** after approval drift, `gate red` can still execute commands and review/SHIP gates can accept evidence. The excluded plan’s mutation is invisible to candidate identity.  
   **Fix:** centrally validate state/run identity and both approval bindings before every mutating gate.

2. **AIS2-02 · blocker · [run-engine.mjs:189](/Users/ahmedabdelfatah/Documents/personal-projects/AI-Skills/skills/ship-ticket/scripts/run-engine.mjs:189)**  
   **Evidence:** `let alive = env ? false : E.alive(a.pgid)`; an envelope immediately enters `record()`. Successful recording never checks quiescence.  
   **Consequence:** surviving descendants can continue writing after their node becomes `done`, including on Windows where quiescence is unknown. An in-memory check confirmed `done` with zero liveness checks.  
   **Fix:** establish whole-group quiescence before accepting completion or releasing ownership; unknown quiescence must remain a judgment point.

3. **AIS2-03 · blocker · [run-engine.mjs:304](/Users/ahmedabdelfatah/Documents/personal-projects/AI-Skills/skills/ship-ticket/scripts/run-engine.mjs:304)**  
   **Evidence:** `if (S.judgments.length) break` exits without draining `running`; `Promise.race(running.values())` can also reject while siblings remain active.  
   **Consequence:** an ownership failure or persistence error releases the ticket lock while other attempts still run and commit state. A subsequent command can race those commits and lose ledger updates.  
   **Fix:** retain the lock through a `finally` barrier that settles or cancels every launched attempt.

4. **AIS2-04 · blocker · [run-engine.mjs:212](/Users/ahmedabdelfatah/Documents/personal-projects/AI-Skills/skills/ship-ticket/scripts/run-engine.mjs:212)**  
   **Evidence:** reconciliation handles only `['intent', 'launched']`; RED persists `status: 'running'`. Worker admission also ignores persisted `S.locks`.  
   **Consequence:** after a gate-process crash, `drive` ignores a surviving RED runner and may launch another worker using its database/port/cache. The in-memory reconciliation returned “no live attempt” without checking the runner.  
   **Fix:** unify worker/RED recovery and make admission honor durable resource holders.

5. **AIS2-05 · blocker · [run-engine.mjs:479](/Users/ahmedabdelfatah/Documents/personal-projects/AI-Skills/skills/ship-ticket/scripts/run-engine.mjs:479)**  
   **Evidence:** RED takes `command: input.command`, ignoring bound `config.testCommands`; dispatch subsequently checks only the truthiness of `S.gates?.red?.[d]`.  
   **Consequence:** an unapproved command can establish RED, and accepted evidence survives changes to the tested specs. Stored spec digests and baseline are never validated when admitting production work.  
   **Fix:** bind runner configuration to the approved DAG, invalidate changed RED evidence, and verify its fingerprints before dependent dispatch.

6. **AIS2-06 · blocker · [run-engine.mjs:489](/Users/ahmedabdelfatah/Documents/personal-projects/AI-Skills/skills/ship-ticket/scripts/run-engine.mjs:489)**  
   **Evidence:** review validation receives `frozen_candidate: candidate`, where `candidate` is freshly computed. Original reviews are allowed whenever their execution ID is new.  
   **Consequence:** unexpected post-freeze drift and a prior FAIL can be bypassed by submitting another original review under a fresh ID. This reproduced in memory.  
   **Fix:** enforce the existing freeze and terminal execution state; require explicit retry authorization linked to the predecessor.

7. **AIS2-07 · blocker · [run-engine.mjs:489](/Users/ahmedabdelfatah/Documents/personal-projects/AI-Skills/skills/ship-ticket/scripts/run-engine.mjs:489)**  
   **Evidence:** `builders: S.builders ?? []`; initialization and attempt completion never populate `S.builders`.  
   **Consequence:** production CLI reviews always check independence against an empty builder roster, allowing builder identities through both reviewer checks.  
   **Fix:** persist builder execution identities from real dispatches and validate reviewers against that authoritative roster.

8. **AIS2-08 · major · [gate.mjs:239](/Users/ahmedabdelfatah/Documents/personal-projects/AI-Skills/skills/ship-ticket/scripts/gate.mjs:239)**  
   **Evidence:** `contractGaps()` checks array types, while failed outcomes are detected only by `o === 'FAIL'`.  
   **Consequence:** empty coverage/criteria/rule arrays and invalid security outcomes such as `"BANANA"` produce `review_accepted`. This reproduced in memory.  
   **Fix:** validate nested schemas and outcome enums, then require coverage against the bound candidate, acceptance criteria and applicable rule inventory.

9. **AIS2-09 · major · [run-engine.mjs:490](/Users/ahmedabdelfatah/Documents/personal-projects/AI-Skills/skills/ship-ticket/scripts/run-engine.mjs:490)**  
   **Evidence:** accepted FAIL handling only pushes `v.record`; it discards `v.repair`. `confirmRepair()` sets `S.confirmation` but never appends the `kind: 'repair'` record required by confirmation validation.  
   **Consequence:** the supported CLI cannot complete FAIL → REPAIR → confirmation. Tests bypass this gap by editing state directly.  
   **Fix:** provide a locked repair-registration transition and persist completion with old/new candidate IDs, ownership and affected closure.

10. **AIS2-10 · blocker · [gate.mjs:357](/Users/ahmedabdelfatah/Documents/personal-projects/AI-Skills/skills/ship-ticket/scripts/gate.mjs:357)**  
    **Evidence:** SHIP readiness checks review/proof objects but never checks node completion, active attempts, pending repairs or `state.judgments`.  
    **Consequence:** `SHIP_READY` was reproduced with a failed production node, a launched attempt, an ownership violation, and a supplied `echo pass` proof.  
    **Fix:** require completed required work, quiescence and resolved judgments; bind local proof to the required project commands.

11. **AIS2-11 · major · [run-engine.mjs:321](/Users/ahmedabdelfatah/Documents/personal-projects/AI-Skills/skills/ship-ticket/scripts/run-engine.mjs:321)**  
    **Evidence:** `evaluateBudget(E.S.usage, budget)` receives no phase; imported usage is never loaded into that ledger; `runRepairs()` skips budget admission entirely.  
    **Consequence:** phase-only budgets never stop dispatch, host/reviewer costs do not affect ticket limits, and repairs bypass exhausted budgets. Warning/unknown flags are also discarded.  
    **Fix:** refresh the deduplicated usage ledger before every dispatch, pass the phase, apply admission to repairs, and expose budget flags in status.

12. **AIS2-12 · major · [run-engine.mjs:115](/Users/ahmedabdelfatah/Documents/personal-projects/AI-Skills/skills/ship-ticket/scripts/run-engine.mjs:115)**  
    **Evidence:** `deliver()` calls `io.appendLogOnce(...)` without recovery and runs before drive/resume/gate work. Carrier REPAIR also retains unconditional timing-log authorization at `carrier.mjs:511`.  
    **Consequence:** an unwritable log blocks progress or turns a committed gate decision into a command failure; carrier repairs still depend on telemetry despite engine state.  
    **Fix:** report sink failures as telemetry degradation while preserving replayable state; use engine authorization whenever state exists.

**overflow:** `true`

Verification: no edits. The full test command yielded **107 passed / 96 failed** under the restricted sandbox, including blocked temporary-directory creation (`EPERM`); this is not a clean suite result. Additional read-only, in-memory checks reproduced the acceptance bypasses described above.
