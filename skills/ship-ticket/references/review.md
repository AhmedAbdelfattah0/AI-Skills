# REVIEW — the manifest, the three passes, and the reconciliation

Loaded when the REVIEW phase starts. Pass B's CLI contract lives in
[codex-cli.md](codex-cli.md).

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
   **once every pass has returned and been validated**, never during the wave:
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
a mutate-and-restore inside the wave. Its safety therefore rests on the passes
being read-only and on the orchestrator writing nothing during the wave. If you
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
- **serial** — the same passes, in the same scope, one after another against the
  unchanged manifest.

Declare which ran, **per wave** — recon and review can differ, and a run that
fanned out its review while serializing an hour of recon must not report as
concurrent.

**Every review pass returns the same shape, whatever the mode:** `manifest_id` ·
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

## Pass A — a fresh reviewer with no build context

A **fresh reviewer subagent** with no build context, or a read-only
`codex-delegate` dispatch. Not `/code-review` — that name belongs to CodeRabbit in
this library, and letting one command fill two slots collapses two supposedly
independent reviewers onto one engine.

Give it the **manifest**, the ticket's ACs, the plan's *Not in this ticket* list,
and the rule vocabulary. **Never let it derive its own scope.**

It owns acceptance criteria, behaviour, edge cases and scope creep — the
systematic rule catalogue is pass C's job, not a thing to repeat. For UI tickets
it also carries the parity investigation (see
[design-parity.md](design-parity.md)) and returns per-screen verdicts as unsigned
data stamped with the scope digest it reviewed.

## Pass B — a different model in a different process

See [codex-cli.md](codex-cli.md). This is what makes the review genuinely
cross-model: a model reviewing itself twice is one pass. It starts **first**,
because it is routinely the longest.

Pass C shares pass A's model, so it adds **method** diversity, not model
diversity. Never report it as a third independent opinion.

## The reconciliation barrier

Wait for all three **once**. Then:

1. **Verify coverage against the manifest** — not against a freshly derived file
   list, which may have drifted. A pass that reviewed a narrower set has gated
   nothing: re-run it against the missing paths and treat the union as the pass.
2. **Check the manifest ID.** Changed during the wave → the passes that predate
   the change do not describe the current tree. Re-run them. A stale pass is not
   a pass.
3. **Reconcile into one attributed set** — `[claude]` (pass A), `[codex]` (pass
   B), `[rules]` (pass C) — and apply **one batched fix set**. This increments the
   mutation budget once.
4. **Fixes obey the Design Contract too.** Check every proposed fix path against
   the approved contract *before* applying it. A fix needing a file outside it is
   a material divergence and goes back through plan mode — review findings are not
   a side door around the gate that governs implementation.
5. **Re-run the affected commands**, scoped only where the repo proves that safe,
   then snapshot `F1` and **promote it to the accepted manifest**. It, not `F0`,
   is what the final allowlist check compares against — without this promotion
   every accepted review fix would fail that check.
6. **Revalidate the delta only.** Re-run passes A and B over the latest adjacent
   delta `F(n−1) → Fn` concurrently; re-run only the rule rows and tests the fixes
   touched; re-derive the unsigned parity verdict if an owned screen, its
   reference or the artifact changed; re-attack only the surfaces the fix touched.
   Append-only allowlisted output needs no re-review. **Each further round
   increments the mutation budget, and the budget bounds the sequence.**

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
