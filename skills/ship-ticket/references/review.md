# REVIEW — the manifest, the two rounds, and the barriers

Loaded when the REVIEW phase starts. Pass B's CLI contract lives in
[codex-cli.md](codex-cli.md).

**The shape, before the detail.**

```
round 1   pass A + pass B + pass C          concurrent, mutually blind, over F0
barrier 1 triage -> capture preimages -> one fix batch -> the fix packet -> F1
round 2   the fix review                    sighted: findings paired with changes
          + pass A and pass B over F0->F1   still blind, still cross-model
          + the C rows / tests / parity / attacks the fixes touched
barrier 2 fix what round 2 found -> F2, and repeat round 2 on the new delta
```

**Why the fixes get their own round.** A reviewer that finds a problem cannot tell
you whether your fix for it works — it never sees the fix. A finding that was never
a problem produces a change indistinguishable from any other. And a fix can be
locally correct and wrong for a caller. The old design did re-run A and B over the
fix delta, so the fixes were not unreviewed — **what was missing is the causal
package**: which finding produced which change, and what the code looked like
before. Without it no reviewer can judge whether a finding was real or whether its
fix fits.

**So round 2 adds a pass; it does not replace one.** Passes A and B still review
the delta, blind, exactly as before. Removing either would leave the changes a
reviewer asked for as the only content no second model read.

## The freeze — a manifest, not a commit

**This skill creates no review-freeze commit.** The single gated commit is the
last thing that happens. What concurrent passes need is not a commit but a
**stable, shared description of what they are reviewing**.

Compute it **once** and hand the identical copy to every pass. Call it `F0`.

1. **Repository identity** — canonical path, branch, `HEAD` OID, target-base OID,
   merge-base OID.
2. **NUL-safe git state across all four layers** — the committed delta
   `merge-base…HEAD` (a resumed run may carry WIP commits, and status cannot see
   them), plus porcelain-v2-equivalent status for index and worktree kept
   **separate**, plus all untracked files. A manifest built from status alone
   misses everything already committed on the branch.
3. **Per path** — exact path bytes; index and worktree status; rename/copy origin
   and destination; explicit deletion tombstones; HEAD/index/worktree file type
   and mode; index blob OID plus an independent content digest; worktree content
   digest.
4. **Special types** — symlinks recorded **as** symlinks with the link-target
   bytes hashed, never dereferenced; permission bits recorded separately from
   content; submodules either **rejected dirty at the freeze** or manifested
   **recursively**. A bare dirty bit cannot distinguish one dirty submodule state
   from another, so it is not a freeze.
5. **Untracked files** — type, mode, path, content digest. `git diff` cannot
   represent them and they are in scope.
6. **Ignored but load-bearing inputs** — only those the local app, tests or review
   actually consume. Record **opaque digests**; never copy secret contents in.
7. **Review policy** — reviewed paths; excluded generated/vendor/lock artifacts
   **with reasons**; `design_ref`; owned screens; attack surfaces.
8. **The post-freeze allowlist** — the exact derived outputs that may be appended
   **once every pass in a round has returned and been validated**, never mid-round:
   the parity and security signature blocks; each accepted deviation's decision,
   approver and date; each stub's follow-up ticket key; the final
   `mutation_round`; the run record; session-log fields. **List them explicitly**
   — a close-out field the allowlist forgot makes the final check reject every run
   that used it. Name the **fields**, not just the files: a path-level allowlist
   would permit arbitrary edits inside an allowed artifact, so record the
   permitted field names and each artifact's immutable-prefix digest and verify
   both. **Any code, test or docs mutation outside this allowlist voids the
   reports.**
9. **Manifest ID** — a digest over the manifest under one deterministic
   serialization: fields in a fixed order, paths as raw bytes sorted bytewise,
   NUL-delimited, named hash algorithm. The serialization is
   **`ship-ticket-manifest-v1`** and the digest is **SHA-256** — pinned here
   rather than left to each repo, so two runs produce comparable IDs. Recompute
   before dispatch and after every pass; any mismatch discards the affected
   outputs.

**Computing the scope once is safer, not just cheaper.** A bare `git diff` hides
staged changes, and a pass that reviewed a narrower set than the change has
**gated nothing**. One manifest removes N independent chances to under-scope.

**A manifest is an integrity check, not an immutable snapshot.** It cannot detect
a mutate-and-restore inside a round. Its safety therefore rests on the passes
being read-only and on the orchestrator writing nothing mid-round. If you
need a genuine snapshot, materialize one that carries untracked, symlink and
submodule state — **`git stash create` alone does not**, because it has no
include-untracked form here and untracked files are explicitly in scope.

**Recompute `ui_required` BEFORE computing `F0`**, and update the plan header
then. The value is `contract-owns-a-screen OR diff-touches-the-view-layer`, and
only now does the diff exist — but the header is a file, so writing it after the
freeze makes the manifest stale the instant it is created. Order: recompute,
write the header, *then* freeze.

## Orchestration modes

The wave is an orchestration convenience, never a source of verdicts.

- **workflow** — schema-validated, resumable, blind and concurrent. Preferred
  whenever the orchestrator has one; this skill's instructions authorize it.
- **fan-out** — plain concurrent read-only subagents; same passes, no schema or
  resume.
- **serial** — the same passes, in the same scope, one after another against that
  round's unchanged manifest.

**The mode is per round, and the rounds can differ** — a run may fan out round 1 and
serialize round 2. Declare each.

Declare which ran, **per wave** — recon and review can differ, and a run that
fanned out its review while serializing an hour of recon must not report as
concurrent.

**Every review pass returns the same shape, whatever the mode:** `manifest_id` —
and for a pass over a delta, `source_manifest_id` and `candidate_manifest_id`, since
one ID cannot describe a comparison between two trees ·
`reviewed_paths` · `excluded_paths` (each with a reason) · `findings` (severity,
`file:line`, quoted line, fix) · **`verdicts[]`** — a list, because one run can owe
both a parity and a security verdict, each carrying its name, `scope_digest`, the
verdict and the reviewer's identity. **The wave returns verdicts, not
signatures.** Malformed output is re-requested or the pass re-run — never silently accepted,
because a pass that returned nothing readable has gated nothing. **Bound it at
two retries per pass.** This is deliberately *not* the mutation budget: a re-run
mutates nothing, so it would never increment that counter and would loop forever.
Two failures to return a readable result and the pass has not gated anything → ✋ STOP.

**Fan-out shape:** shard the rule pass by rule family, and the attack inventory
and test design by surface. Parity shards per reference-backed screen **inside**
pass A. Every shard aggregates into **one** table and **one** contract — two
tables mean two half-reviews, and a rule that fell between them is invisible.

## Pass C — the rule checklist

The routed specialist's Verification Pass over the contracted files, plus
whole-diff rows. **One table: `rule → PASS/FAIL/N-A → evidence`.** Evidence is a
file path, a line, or a clause — never the word "yes".

```
specialist rule rows (the contract's [ARCH]/[D] rules)
+ every [NN] row — always in force, always present
+ AI-FM  row — whole diff: the LLM failure modes, The Floor, refactoring discipline
+ UNIVERSAL row — whole diff: universal-principles (Clean Code · the SOLID smell
  table · CQS · DRY-as-knowledge + the Rule of Three · the complexity and nesting
  ceilings + KISS · the ranked YAGNI list) + the project constitution's
  Always/Never lists and Self-Check, where one exists
+ TEST row — when the diff includes test files
+ DOC  row — when the diff touches docs surfaces
```

**`AI-FM` and `UNIVERSAL` are both required and are not the same row.** `AI-FM`
catches the model's failure modes; `UNIVERSAL` catches the engineering ones.
Folding one into the other silently drops SOLID, DRY, KISS, CQS, the complexity
ceilings, the full YAGNI list and the project's own constitution. A `UNIVERSAL`
row that walked only the failure modes is a degradation to declare, not a fold.

**Pass C derives the security scope independently.** Digest equality proves the
recorded *inputs* are unchanged; it cannot prove the earlier pass enumerated every
surface and transitive owner, or read them correctly. An omitted owner yields the
same digest twice, because both computations start from the same incomplete
inventory. So pass C re-derives the scope and reviews the controls itself.

**Reuse is limited to deterministic tool output** — a grep result, a lint run, a
test result — bound by path plus content digest plus the runner command or
rule-set version, and refreshed whenever a delta moves a bound input. **Never a
semantic judgment.** The `TEST` and `DOC` rows work this way: pass C verifies the
semantics itself and *references* the deterministic runner output by its binding
rather than re-running the guard.

**A row may not be omitted.** Every `[NN]` rule in the loaded inventory, every
contract-named `[ARCH]` and `[D]` rule, and separate whole-diff `AI-FM` and
`UNIVERSAL` rows are in force on every ticket. The `RULES | DEGRADED` sentinel
applies only where **no inventory could be loaded at all**, and it replaces only
the inventory-derived rows — never `AI-FM`, `UNIVERSAL`, `TEST` or `DOC`, which
are walked from this skill's and the hub's descriptions.

A mechanically-derived `N/A` needs an applicability reason. **Never infer `N/A`
just because the handler that owns a rule did not change** — an indirect service,
middleware, config or migration change can move the surface. Unknown applicability
goes to semantic review, not to `N/A`.

Any `FAIL` here blocks **acceptance and close-out**. It does not retroactively
invalidate the concurrent work: running the passes together cannot turn a FAIL
into a PASS, it only risks discarding review work when the rule pass fails.

## Round 1 — find

**Passes A, B and C, dispatched together, blind to each other, report-only, over
`F0`.** Pass B starts first; it is routinely the longest.

Pass C shares pass A's model, so it adds **method** diversity, not model diversity.
Never report it as a third independent opinion.

They are expected to confirm what BUILD already did — and they must still find and
report every violation at full severity, exactly as if no build-time check had run.
A long finding list means BUILD skipped its own checks; it never means a pass
should have looked less hard.

## Round 2 — verify the fixes

Dispatched together over `F1`:

- **the fix review**, sighted on round 1's findings and what they caused;
- **passes A and B over the adjacent delta `F0 → F1`**, still blind to the findings
  and to each other — the fix batch keeps its cross-model review;
- **the rule rows, tests, parity verdict and attack surfaces the fixes touched.**

The fix review and pass A are **different agents and must stay so**: pass A is
defined by not knowing what round 1 found, the fix review by knowing. One agent
cannot be both.

**Each round has its own manifest.** `F0`, `F1`, `F2` form a chain; a round after a
fix is reviewing a different program, and reusing an earlier manifest ID for it
would describe a tree that no longer exists. The latest accepted `Fn` is what SHIP's
allowlist check compares against.

## Pass A — a fresh reviewer with no build context

A **fresh reviewer subagent** with no build context, or a read-only
`codex-delegate` dispatch. Not `/code-review` — that name belongs to CodeRabbit in
this library, and letting one command fill two slots collapses two supposedly
independent reviewers onto one engine.

Runs in **round 1** over `F0`, and again in **round 2** over the adjacent delta —
blind both times. Its round-2 pass is what keeps a Claude reviewer reading the
fixes; its round-1 pass is what makes it a genuine second opinion on the build,
formed before any finding reshaped the code.

Give it the **manifest**, the ticket's ACs, the plan's *Not in this ticket* list,
and the rule vocabulary. **Never let it derive its own scope.**

**Never show it any other pass's findings, or which lines were fixed.** Its
independence is the whole reason it exists; telling it what another reviewer
flagged anchors it to that reviewer's reading and turns a second opinion into a
confirmation. It reviews the code, not the history. That holds in both rounds.

It owns acceptance criteria, behaviour, edge cases and scope creep — the
systematic rule catalogue is pass C's job, not a thing to repeat. For UI tickets
it also carries the parity investigation (see
[design-parity.md](design-parity.md)) and returns per-screen verdicts as unsigned
data stamped with the scope digest it reviewed.

## Pass B — a different model in a different process

See [codex-cli.md](codex-cli.md). This is what makes the review genuinely
cross-model: a model reviewing itself twice is one pass. Runs in **round 1** over
`F0`, starting first within it, **and again in round 2 over the fix delta** — the
changes a reviewer asked for need a second model as much as the original code did.

## The fix packet — what barrier 1 must produce

Round 2 cannot be dispatched without this, and it **cannot be reconstructed
afterwards from the diff**. Build it while applying the fixes.

1. **Preimages.** Before mutating anything, capture the **contents** of every file
   the batch will change. The manifest holds digests, not bytes: once an
   uncommitted file is overwritten its previous state is unrecoverable, and the
   fix review's central question — what did this look like before — becomes
   unanswerable. Store them outside the worktree.
2. **Change units, not just hunks.** A hunk cannot represent an add, a delete, a
   rename, a mode change, a symlink retarget, a submodule move or an untracked
   file — all of which the manifest already recognises. Each change unit carries
   its path, its kind, its preimage (or a deletion tombstone) and its postimage.
3. **The attribution map, many-to-many.** Each change unit lists the finding IDs it
   serves; each finding lists its change units.
4. **The packet digest**, over the findings, dispositions, preimages and
   attribution, under the manifest's serialization. The fix review binds to
   `source_manifest_id` (`F0`), `candidate_manifest_id` (`F1`) and this digest.

**Barrier 1 does not dispatch round 2 until the packet balances:**

```
every change unit between F0 and F1  ==  the union of all attributed change units
every referenced finding id resolves · every referenced change unit resolves
every preimage matches F0 · every postimage matches F1
```

The cases that break naive attribution, and their answers:

| Case | Answer |
|---|---|
| one change serves two findings | it lists both IDs — the map is many-to-many by construction |
| a file no finding named | allowed **if** it is inside the Design Contract and carries a stated causal reason; outside the contract it is a material divergence, not an attribution problem |
| a finding fixed by deleting the code it was about | the change unit is a deletion with its preimage and a tombstone |
| a rejected finding | maps to no change units — and if it has one, the rejection was not a rejection |
| formatter or generator output | attributed as a mechanical consequence of the change that triggered it, or reverted before dispatch |
| a change with no finding at all | **the balance check fails.** Unattributed work entered the batch — that is the hole this packet exists to close |

"An unattributed fix is itself a finding" detects nothing if the executor simply
omits the attribution. **The balance check is what makes it real**, and it is
arithmetic, not judgment.

## The fix review — the pass that reads round 1's consequences

A **fresh reviewer, separate from pass A and from you**. It is the only pass shown
round 1's findings, and it sees them paired with what they caused.

**Input:** the fix packet above · the ticket's ACs and the plan's *Not in this
ticket* list · the rule vocabulary · and, for "did it break anything", the
**affected closure** — the changed files plus their direct callers and the
contracts they expose, derived from `F1`. Judging breakage from the changed lines
alone answers a whole-program question by looking at a hunk.

**It answers, per finding:**

| Question | Catches |
|---|---|
| **Was it real?** | a change made for something that was never a problem |
| **Does the fix address it?** | a change that silences the symptom the reviewer described without fixing what it described |
| **Did the fix break anything?** | the failure a delta diff hides — locally fine, wrong for a caller, a contract, or an untested case |

**And once over the batch: was anything *rejected* that was real?** That is the
expensive direction — a correct finding talked away with a plausible reason — and
it is a check on my triage, which is exactly why it cannot be me who performs it.
Rejections go to it with the same weight as fixes.

**Output, per finding** — an enum and its evidence, never prose alone:

```
finding_id · was_real: yes | no | unclear      + the code or ticket fact
            · addressed: yes | partly | no     + what the fix does vs what was asked
            · regression: none | suspected | confirmed + the caller/contract/case
rejections  · rejection_upheld: yes | no       + the fact that settles it
packet      · source_manifest_id · candidate_manifest_id · fix_packet_digest
            · reviewed_paths · excluded_paths (each with a reason)
```

A `confirmed` regression or an overturned rejection is a finding and enters
barrier 2. `unclear` and `suspected` are findings too — they are not passes.

**A finding confirmed as not real: revert the change by default.** It was not
required by an AC, a rule, or the approved plan, so keeping it is unrequested work
in the ticket's diff — which the scope rules forbid and which the disposition
contract already refuses when it says a factually wrong finding is not implemented
anyway. Keep it only where an AC, an applicable rule, or an approved plan item
independently requires it, and say which. Either way it is **recorded**: it is the
measure of how much of the review was churn.

**Later rounds get their own packet.** Round 2's findings produce round 3's fix
batch, so barrier 2 builds a packet over `F1 → F2` exactly as barrier 1 did over
`F0 → F1`. A round with no fixes builds no packet and dispatches no fix review.

**Failure and degradation.** Malformed output follows the same two-retry cap as
any pass. If no fresh-reviewer route exists, perform the three questions yourself
and record `fix review ran WITHOUT independence` — a named loss, because the pass
whose purpose is auditing the triage was performed by whoever did the triage.


## The barriers

**Barrier 1, after round 1.** In order:

1. **Verify coverage against the manifest** — not against a freshly derived file
   list, which may have drifted. A pass that reviewed a narrower set has gated
   nothing: re-run it against the missing paths and treat the union as the pass.
2. **Check the manifest ID.** Changed during the round → the passes that predate
   the change do not describe the current tree. Re-run them. A stale pass is not a
   pass.
3. **Reconcile into one attributed set** — `[claude]` (pass A), `[codex]` (pass B),
   `[rules]` (pass C) — and give every finding exactly one disposition.
4. **Capture the preimages** of every file the batch will change, before changing
   anything. This is the step that cannot be done late.
5. **Apply one batched fix set**, building the fix packet as you go. **Increments
   the mutation budget iff code, tests or docs actually changed** — a round where
   every finding was rejected, or where there were none, spends nothing.
6. **Fixes obey the Design Contract too.** Check every proposed fix path against
   the approved contract *before* applying it. A fix needing a file outside it is a
   material divergence and goes back through plan mode — review findings are not a
   side door around the gate that governs implementation.
7. **Re-run the affected commands**, scoped only where the repo proves that safe,
   then snapshot `F1` and **promote it to the accepted manifest**. It, not `F0`, is
   what SHIP's allowlist check compares against — without this promotion every
   accepted review fix would fail that check.
8. **Balance the fix packet.** Every change between `F0` and `F1` attributed, every
   reference resolving, every preimage matching `F0` and postimage matching `F1`.
   **It does not balance → do not dispatch round 2**: something changed that no
   finding asked for, and that is the hole the packet exists to close.
9. **Dispatch round 2** over `F1`.

**No fixes at barrier 1?** Round 2 still runs if anything was **rejected** — the
packet then carries the rejections, their stated reasons and no change units, and
the fix review answers only its batch question: *was anything rejected that was
real?* That is the audit rejections exist to receive, and skipping it would let a
round that rejects everything escape review entirely — the cheapest way to dodge
the check.

Only a barrier with **no findings at all** skips round 2. Record that it did.

**Barrier 2, after round 2.** The same steps over round 2's findings, producing
`F2` and its own packet. **Each further round increments the mutation budget, and
the budget bounds the sequence** — this is the loop that used to have no exit.

**Further rounds are round 2 again, on the newest delta.** The fix review over the
new packet; passes A and B blind over `F(n−1) → Fn`; only the rule rows and tests
the fixes touched; the parity verdict re-derived if an owned screen, its reference
or the artifact changed; only the attack surfaces the fix touched. Append-only
allowlisted output needs no re-review.


### Weigh the round before you call it non-convergence. Count is not severity.

The mutation budget stops a diff that **cannot converge** — not a round that
produced a large number. Before surfacing a stop, sort the round's findings into
**behaviour** and **record**: a shipped-behaviour defect (authorization, a
clearance, a contract that forbids a value the service returns, a wrong figure)
against prose (comments, docblocks, counts, artifact wording) and assertions that
cannot fail. **State both numbers.**

A round of thirty where twenty-nine are stale comments and one is a real leak is
**a fix list, not a non-convergence signal** — and presenting it as one argues for
amputating working scope on evidence that does not support it. Prose churn is
expected in a repository whose comments are the design record; it says nothing
about whether the code is settling.

**And a finding is itself a record entry, so it drifts like one.** Before a finding
becomes an argument to stop, re-verify it — especially one that says *another
record is false*, which is the shape most likely to be wrong, because it is derived
rather than observed. **A correct general mechanism does not refute a claim about a
specific case: instantiate the case.** Reading the function and reasoning from its
rule is not the same as running the fixture's own inputs through it — the inputs
are what the claim depends on. Where a stop would rest on such findings, get an
independent ruling on them first; a stop argued from findings that do not survive
review costs more than the round it was avoiding.

### Dispositions — every finding gets exactly one

| | When | Requires |
|---|---|---|
| **fix** | the default | — |
| **skip** | it contradicts a `[D]` or `[ARCH]` rule | the **rule ID**, named. "It conflicts with our conventions" can be written about any finding, which is exactly why it is not accepted |
| **reject — factually wrong** | the finding's premise is false | the code or ticket fact that disproves it, cited. Not intuition, and not implementing it anyway |
| **reject — out of scope** | it is real but belongs to another ticket | the plan's *Not in this ticket* line, or a new ticket key |
| **human waiver** | an `[NN]` rule would have to bend | ✋ STOP. This is the user's decision, recorded |

If you reach for the ID and the rule does not say what you need it to say, the
reviewer was right. **Degraded rule pass = no IDs loaded = no skips at all.**
Codex findings get no special deference *and* no discount for coming from another
vendor.

A skipped finding is a deviation: record it in the deviations ledger of whichever
family member you actually invoked, `.claude/<invoked-skill>/deviations.md`.
Parity deviations live in the parity artifact instead — they carry a human
approver, not a rule ID.

**A finding that contradicts an `[NN]` rule is never skipped.** If a reviewer and
an `[NN]` rule disagree, the reviewer is almost certainly right and you have a
real problem. ✋ STOP.
