# Known issues — `ship-ticket`

Open defects in the `ship-ticket` skill as of the `refactor/review-terminates`
branch. Everything here was found by blind Codex reviews of the REVIEW rewrite,
and everything here was left open **deliberately** — either because it predates
the rewrite, or because closing it changes a contract outside REVIEW and is worth
a decision rather than a patch.

**What the rewrite was for, and whether it worked.** REVIEW used to say "further
rounds are round 2 again", so every repair fed the identical probabilistic
reviewer and the phase had no terminating condition. Five independent reviews now
agree it terminates: one discovery wave, one repair barrier, one terminal verdict,
no round 3, PR-bot findings routed to a new run. That part is done. None of the
issues below reintroduces a loop; they are contradictions, gaps and
under-specifications that make an executor invent a rule.

**Untested against a real ticket.** The ~20-minute target is a model, not a
measurement. Nothing below is more important than running one real ticket and
timing it.

---

## Open — introduced by the rewrite, need a design decision

### 1. `mutation_round` is not partitioned across runs · blocker

`mutation_round` is derived as the length of `batches[]`, and `batches[]` lives in
one ticket-keyed plan with no run boundary and no `run_id`. When a run concludes
unshipped and a new one starts on the same ticket, keeping the old entries makes
the new run inherit the old mutation count, and clearing them violates
append-only. A run that ended at mutation 3 therefore has no executable
continuation at all.

*Shape of the fix:* give run-state entries a run partition and derive the budget
from the active run only — or make each run write a versioned run-record path
instead of a singleton.

*Why it is open:* the schema is consumed by PLAN, PROVE, REVIEW and SHIP. Adding a
partition touches every one of them, and getting it wrong reintroduces the
"two definitions of the same field" failure this branch spent four commits
removing.

### 2. SHIP can re-enter a run that already concluded · blocker

The spine says any stop after the REVIEW-start entry ends the current run. SHIP
then permits resuming after a CI, PR or tracker stop, and permits a byte-identical
retry that reruns CI only. Those two rules cannot both hold.

It is worse than a wording conflict: the resume predicate cannot be satisfied
after the commit even if you wanted it to be. The manifest includes `HEAD` and the
committed/staged/unstaged split, and all of those change the moment the reviewed
working tree becomes a commit — so the tree SHIP would resume against never
matches the one REVIEW signed.

*Shape of the fix:* pick one contract and state it everywhere. Either SHIP
failures require a new run, or the point-of-no-return rule is narrowed to REVIEW
and candidate failures and the resume predicate is changed from manifest equality
to a reviewed-content identity that survives a representation-only commit.

*Why it is open:* this is the only remaining path back into a concluded run, and
it is a SHIP contract rather than a REVIEW one. Both branches are defensible and
the choice changes what "one commit" means. It is the first thing to decide before
this branch merges.

*Note:* this does **not** reintroduce the review loop. Codex re-verified after the
latest commits that the REVIEW graph has no path back into repair or re-review.
The re-entry here is into SHIP, after a verdict, and it repeats no review.

### 3. The fix packet has no stated carrier · minor

Preimages are now required to live outside the worktree, but where the packet
itself is stored — and how it survives between barrier 1 and the terminal
reviewer — is unstated. An executor has to invent it.

---

## Open — predates the rewrite

Verified present at `f40171f`, the commit before this branch. These are not
regressions; they were surfaced because nobody had audited `ship-ticket` this
hard before.

### 4. SHIP's record cannot contain SHIP's outcome · blocker

The full run record must be on disk before the single commit, but the final SHIP
timestamp, the PR URL, the CI result and the tracker transition do not exist until
after it. No producer can emit those facts at the time the contract requires them.

*Shape of the fix:* define a precommit cutoff and report postcommit outcomes
outside the committed projection — or drop the one-commit invariant. The first is
almost certainly right.

### 5. VAPT and `ship-ticket` disagree about installing a CI check · major

`vapt` STEP 8 says to add a merge-blocking check; `ship-ticket` says installing it
is repo setup and never something a ticket adds after the freeze. Invoking VAPT
from PROVE therefore instructs the agent both to mutate CI and not to mutate CI.
Following VAPT makes an out-of-contract change; following `ship-ticket` leaves
VAPT's stated success criterion unmet.

*Shape of the fix:* make VAPT's STEP 8 caller-aware — install only in standalone
setup work, detect-and-declare when invoked as a gate.

### 6. No single verdict vocabulary · major

Rule rows are `PASS/FAIL/N-A`, other checks are told to use a richer enum,
terminal outcomes use bare `PASS`, and VAPT demonstrates `FIXED` and `N/A`. There
is no one parseable row format, and the missing-VAPT producer is told to emit
families while two consumers require rules by ID.

---

## Open — accepted, with the reason

### 7. A renamed test still stops the run · major, half-fixed

Test IDs now carry a digest of the test body, so weakening a test in place is
detected — that was the dangerous half and it is closed. The other half remains:
a test renamed with no change in meaning also changes its ID, so it lands in the
coverage-changed branch and ends the run. That is a false stop.

The reviewer's fix is an immutable rule/surface/polarity ID independent of the
test's name. That is correct, and it is **not** free: it makes every abuse test in
the consuming repository carry a declared stable ID, which is a requirement on
your test suite, not on this skill. It should be a decision, not a side effect of
a bug fix.

A false stop costs one run and states its reason. A missed weakening ships a
boundary whose proof was deleted. The asymmetry is why the dangerous half was
closed first.

---

## The failure that produced most of this

Seven of the defects fixed on this branch are the same mistake: a rule was
rewritten in one file and left standing in another. Not a subtle one — "round 1
must run concurrently" sat four lines above a serial degradation branch, and "run
formatters and generators first" survived in three files after being corrected in
one. Reading the edit shows what was added; it cannot show what failed to be
removed.

Care did not fix this, and had six chances. So the six retired phrases are now in
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
