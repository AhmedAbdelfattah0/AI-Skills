# Known issues — `ship-ticket`

Historical defects found in the `ship-ticket` skill on the
`refactor/review-terminates` branch. **None of the seven issues in this document
remains open.** Each section records the contract chosen by the implementation
pass so later edits can verify the same decision everywhere it is consumed.

**What the rewrite was for, and whether it worked.** REVIEW used to say "further
rounds are round 2 again", so every repair fed the identical probabilistic
reviewer and the phase had no terminating condition. Five independent reviews now
agree it terminates: one discovery wave, one repair barrier, one terminal verdict,
no round 3, PR-bot findings routed to a new run. That part is done. None of the
closed issues below reintroduces a loop.

**Untested against a real ticket.** The ~20-minute target is a model, not a
measurement. Nothing below is more important than running one real ticket and
timing it.

---

## Closed — introduced by the rewrite

### 1. `mutation_round` is partitioned across runs · closed blocker

Human approval now appends an opaque `run_id` in a `run` `START` entry. Every
run-state entry carries that ID, the final `START` selects the active run, and
`mutation_round` counts only that run's `batch` entries. Historical batches stay
append-only without spending a later run's budget. PLAN, PROVE, REVIEW, SHIP and
the spine all state the same partition.

### 2. SHIP no longer re-enters a concluded run · closed blocker

The chosen contract narrows the point of no return to REVIEW and candidate
integrity. A terminal PASS transitions the same run into SHIP. External service
or rerunnable infrastructure failures pause SHIP; they do not conclude it. Resume
requires the same representation-independent `reviewed_content_id`, intact frozen
prefixes and intact append-only entries, and performs only missing idempotent SHIP
operations. It never re-enters REVIEW. Deterministic red CI or any repository-byte
fix concludes the run and requires a new approved execution.

### 3. The fix packet has a stated carrier · closed minor

The packet is `packet.json` in a private per-run temporary directory outside the
worktree, with preimages at opaque change-unit paths. The terminal reviewer gets
its absolute path and expected digest read-only; carrier creation/read failure
stops before mutation, and cleanup follows the verdict or stop.

---

## Closed — predates the rewrite

Verified present at `f40171f`, the commit before this branch. These are not
regressions; they were surfaced because nobody had audited `ship-ticket` this
hard before.

### 4. SHIP has a truthful precommit cutoff · closed blocker

The chosen contract keeps one commit. The committed run-state and session-log
projection stop at `SHIP_READY`; they never predict facts that do not exist. The
commit OID, push, PR, CI, tracker transition, completion time and final SHIP
outcome form an external projection linked by `run_id` and
`reviewed_content_id`, reported to the user and tracker without another repository
write.

### 5. VAPT and `ship-ticket` agree on CI enforcement · closed major

VAPT GATE is detect-only. Existing artifact enforcement is verified; absence is
`DEGRADED` with the checked locations while abuse tests still run in existing CI.
Installing or changing the check is allowed only in explicit setup work whose
approved Design Contract names the CI paths before that work's freeze.

### 6. One canonical outcome vocabulary · closed major

`ship.md` owns `PASS`, `FAIL`, `NOT_TRIGGERED`, `NOT_APPLICABLE` and `DEGRADED`.
Every routed rule row and VAPT row uses `subject_id | outcome | evidence`;
`FULL`, `REUSED`, `GROUPED` and `REDUCED` are execution modes, and `fixed` is
disposition evidence. The validator requires one owner and requires that owner to
express all five outcomes.

---

## Closed — formerly accepted

### 7. A renamed equivalent test no longer stops the run · closed major

Within each boundary and polarity list, REVIEW now compares the multiset of test
body digests before names. Equal digest multiplicity with changed names records a
rename and continues; a changed body changes the multiset and still stops. This
closes the false stop without imposing declared stable IDs on consuming test
suites.

---

## The failure that produced most of this

Seven of the defects fixed on this branch are the same mistake: a rule was
rewritten in one file and left standing in another. Not a subtle one — "round 1
must run concurrently" sat four lines above a serial degradation branch, and "run
formatters and generators first" survived in three files after being corrected in
one. Reading the edit shows what was added; it cannot show what failed to be
removed.

Care did not fix this, and had six chances. So every distinctive retired phrasing is now in
`RETIRED_VOCABULARY` in `scripts/cli.mjs`, and the validator fails the build if any
of them reappears anywhere under `skills/` or in `AGENTS.md`. The first run caught
a seventh survivor that three greps and a full Codex review had all missed.

If you change a load-bearing rule in this repo, add its old phrasing to that table
in the same commit. That is the cheapest check here and the only one that does not
depend on someone remembering.

---

## Closed on this branch

| Was | Now |
|---|---|
| "the fix packet does not balance" was a stop condition with no definition of balancing | the four-line arithmetic is back, with the four attribution cases it does not settle |
| the packet had been reduced to "change unit, preimage, postimage" | preimages are contents stored outside the worktree; change units carry adds, deletes, renames, modes, symlinks, submodules and untracked files — and the `F0` manifest now records a gitlink OID or rejects a dirty submodule, so it can actually supply the preimage a submodule change unit claims |
| `fix_packet_digest` referenced in four places, defined in none | defined |
| a test gutted in place read as "unchanged" | test IDs carry a body digest; weakening lands in the coverage-changed branch |
| "round 1 must run concurrently" with a serial branch four lines below | serial is a stop, not a mode — it buys nothing with three times the wall clock |
| a UI ticket with no fresh-reviewer route degraded instead of stopping, leaving nothing to produce the parity comparison | the stop is back, as it was at `f40171f` |
| formatters ran before the budget was read | the budget is read before anything that writes; everything pre-freeze is one batch. Stated in all three places that give the instruction — the spine's REVIEW summary, `review.md` and `design-parity.md` |
| "no record mutation after `F0`" forbade the run's own required records | the ban names candidate files and frozen prefixes; append-only slots are the exception |
| a red deterministic command after barrier 1's repair had no branch, so "a finding you can fix is work" could invite a second repair | a red command there ends the run — the barrier has already spent its one repair |
| a dirty submodule was frozen as a bare dirty bit, which cannot tell one dirty state from another | rejected at the freeze or manifested recursively by gitlink OID, and the spine's stop list carries the failing branch |
