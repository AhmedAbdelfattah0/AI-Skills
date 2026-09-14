# REVIEW — one discovery wave, one repair barrier, one terminal verdict

Loaded when REVIEW starts. Pass B's CLI contract lives in
[codex-cli.md](codex-cli.md).

## The shape

```text
record     sweep once, repair once if needed, freeze the reviewed prefix
F0         snapshot the complete candidate and frozen record
round 1    pass A + pass B + pass C, mutually blind and report-only
barrier 1  reconcile; stop on record findings; repair code/tests once; build F1
round 2    one sighted independent reviewer returns the terminal verdict
PASS       continue to SHIP
FAIL       end the current run unshipped
```

Round 2 replaces the old fix-review wave, repeated A/B passes, separate parity
attestation and separate security attestation. It never creates repository work.

## Sweep the record once, then close it

Run repository formatters and generators first. Sweep the ticket-owned record in
one pass:

- the plan and its metadata;
- parity and VAPT artifact prefixes;
- changed comments and docblocks;
- ticket-produced docs;
- manually maintained counts and enumerations;
- citations that claim to describe the candidate.

Prefer stable symbols, selectors, rule IDs, test names, route names and manifest
IDs. Replace hand counts with lists or derived presentation values.

Apply record repairs as one batch before `F0`. Then hash each reviewed prefix and
make it immutable.

**What the hashed prefix covers, and what it deliberately does not.** The prefix is
the *narrative*: every claim, count, citation and conclusion a reader would check,
and every conclusion drawn from them. It stops above a delimited **run-state
block** that is outside the digest by construction, and that block is the only
place later writes land.

**Every field in it is append-only.** Each is a list, each entry is written once
and never edited, and a value that "changes" is a new entry — which is what makes
a later write provably not a rewrite of something already reviewed:

```
batches[]        one per post-BUILD repair batch: phase, changed paths, fix_packet_digest
reviewers[]      one per dispatch: which pass, identity, run ID
manifests[]      one per snapshot: label (F0 | F1), manifest ID
outcomes[]       one per verdict or sub-outcome: name, value
timings[]        one per phase boundary: phase, event, timestamp
dispositions[]   one per finding: finding ID, disposition, the rule ID or locator it rests on
```

**The prefix/block split is about WHO may change a line, not about how it reads.**
Entries here carry words — a changed path, a disposition, a rule ID — and that is
fine: what disqualifies text from this block is not being prose but being something
a reader would *check*, and therefore something that goes stale. A claim, a count,
a citation of the tree, a conclusion: those belong in the prefix, before the
freeze. A record of what this run did belongs here, is written once, and can never
drift because nothing later rewrites it.

`dispositions[]` holds the disposition and the locator it rests on. Where a
disposition needs an argument — a rejection the reader must be able to weigh — the
argument goes in the fix packet, which is content the terminal reviewer reads and
rules on, not run state.

**`mutation_round` is derived, never stored.** It is `batches[].length`, and no
artifact carries it as a field.
A barrier that writes a batch entry increments it as a consequence; there is no
separate scalar to update inside the frozen narrative, which is what made the
counter and the freeze contradict each other.

A post-`F0` record mismatch, narrative edit or correction request ends the current
run. Historical finding locators stay bound to their source manifest; they are
not rewritten to match the candidate.

## Freeze `F0`

The manifest records:

- repository path, branch, `HEAD`, target base and merge base;
- committed, staged, unstaged and untracked state;
- per-path status, mode, content digest, rename origin and deletion tombstone;
- symlink targets and dirty submodule state;
- reviewed paths and reasoned exclusions;
- `design_ref`, owned screens and attack surfaces;
- each artifact's immutable-prefix digest;
- deterministic `ship-ticket-manifest-v1` SHA-256 ID.

Recompute `ui_required` and write it before the record sweep and `F0`. Round-1
reviewers receive the identical manifest. Nothing writes while they run. Any
manifest change ends the current run; it does not trigger redispatch.

## Output validity

A pass returns its manifest ID, reviewed paths, reasoned exclusions and findings.
A finding carries a stable ID, severity, source path, quoted source evidence and
fix shape. Line numbers are historical locators bound to that manifest.

Allow one schema-only correction request that reuses the completed analysis. Do
not rerun the semantic review. If the result still lacks required fields or
verifiable coverage, the run stops.

**Round 1 must run concurrently.** Start pass B first — it is usually the longest
— then dispatch A and C immediately over the identical `F0`. The wall clock is the
longest pass, not their sum. Workflow and plain fan-out are both conforming routes.

**Serial execution is a missing-capability degradation, not a preference.** Running
A, B and C one after another costs roughly three times the wall clock for exactly
the same coverage and the same findings, which is why it may not be chosen freely.
Where no concurrent route exists, announce before dispatch:

> ⚠️ REVIEW timing degraded: this agent cannot dispatch A, B and C concurrently.
> Round 1 will run them serially, so its wall clock is their sum rather than the
> longest pass; the ~20-minute REVIEW target is not expected to hold. Coverage is
> unchanged.

Copy that sentence into the run record. Round 2 has one reviewer and therefore has
no orchestration mode.

## Round 1 — find once

Dispatch together over `F0`:

- **Pass A:** a fresh reviewer with no build context. It checks acceptance
  criteria, behaviour, edge cases and scope. For UI tickets it performs the sole
  complete parity comparison described in
  [design-parity.md](design-parity.md).
- **Pass B:** the independent Codex process or declared fallback. It runs once.
- **Pass C:** the complete rule checklist.

Pass C emits one `rule → PASS/FAIL/N-A → evidence` table containing every routed
specialist row, every `[NN]` row, separate `AI-FM` and `UNIVERSAL` rows, plus
`TEST` and `DOC` when applicable. A missing inventory may degrade only its
inventory-derived rows; it never removes the whole-diff rows.

The three passes are mutually blind and report-only. Coverage mismatch, a changed
manifest or an unreadable result after its schema correction ends the run.

## Barrier 1 — the only review write barrier

In order:

1. Reconcile the three result sets and give every finding one disposition.
2. If any finding concerns the frozen record, end the current run before writing.
3. Read `mutation_round`. If it is already 3 and a write is required, end the run.
4. Capture preimages for every file the repair will change.
5. Apply one code-and-test repair batch inside the approved Design Contract.
6. Build a fix packet containing each finding, disposition, change unit,
   preimage, postimage and many-to-many attribution.
7. For each UI change, add its dependency-closed parity impact slice:
   changed nodes, selectors, declarations, tokens, states, translation keys and
   affected owned-screen consumers.
8. **Re-derive the trust boundaries of `F1` and compare them to PROVE's frozen
   inventory by KEY.** A repair can add or move a route, a middleware, a rendering
   sink or a control path *after* the attacks ran — and a brand-new surface has no
   abuse test, no inventory entry, and nothing in CI can invent one. Existing tests
   only catch regressions on surfaces somebody already enumerated.

   **The key is what makes this decidable rather than a judgment call.** PROVE
   records each boundary under a key of `kind` + `identity` + `authz predicate`:

   ```
   kind        route | middleware | rendering sink | control path | job | listener
   identity    the stable name the repo itself uses — route method+path template,
               middleware export, sink symbol, guard or policy name
   authz       the permission, role, clearance or scope the boundary enforces
   ```

   Re-derive the same keys over `F1` and take the set difference:

   - **No key added, no `authz` changed** → record `boundaries: unchanged` in the
     packet and continue.
   - **A key is present in both, and only its implementation moved** → re-run that
     key's committed abuse tests. Green and recorded, continue.
   - **A key present in both whose `authz` component CHANGED** → treat as new. The
     committed tests assert the old predicate and will pass against the new one
     while proving nothing about it.
   - **A key exists in `F1` and not in the inventory** → genuinely new. **End the
     run unshipped** and name the key. Writing the abuse test here would be a
     second repair batch, which is the loop this phase was rebuilt to remove.

   A boundary whose key cannot be derived is treated as new — an identity the repo
   does not name stably is exactly the case where "it is the same one, moved"
   cannot be established.
9. Run only the affected deterministic commands.
10. Snapshot the candidate as `F1` and balance the packet.

Every change between `F0` and `F1` must belong to an attributed change unit.
Record text, comments, docblocks and artifact prefixes remain unchanged. An
unbalanced packet or an unbounded parity impact ends the run.

If no code or test changed, use `F0` as the candidate and record
`fix_packet_digest: none`.

## Round 2 — the terminal reviewer

**Run one sighted reviewer independent of the builder. Always — there is no
condition on it.** A run that skipped this would carry no `reviewer_identity` and
no signature, which is the one thing this phase exists to produce. Where `F1 == F0`
the dispatch is cheap:
the reviewer is handed the unchanged manifest and confirms the round-1 result, and
that confirmation *is* the verdict.

Give the terminal reviewer:

- the ticket, acceptance criteria and approved scope;
- `F0`, the final candidate manifest and frozen-record digest;
- all round-1 findings and dispositions;
- the balanced fix packet;
- the affected caller/contract closure;
- pass A's complete parity result and any barrier-1 parity impact slice;
- the frozen runtime attack evidence.

The reviewer answers:

```text
reviewer_identity
source_manifest_id
candidate_manifest_id
fix_packet_digest | none
frozen_record_status
change_outcome
parity_outcome | NOT_TRIGGERED
attack_review_outcome | NOT_TRIGGERED
security_outcome | NOT_TRIGGERED
findings[]
overall_outcome
```

For each repaired or rejected finding it decides whether the finding was real,
whether the disposition was correct, whether the repair addressed it and whether
the repair caused a regression.

It does not repeat pass A, pass B, pass C or the attacks — barrier 1 step 8 is
what guarantees the repair introduced no surface the frozen attack evidence never
covered. For parity it consumes
the complete `F0` comparison and checks only the recorded impact slice against
the pinned reference. For security it reviews the runtime evidence that PROVE
already generated.

PASS requires an unchanged frozen record, complete coverage, no findings and
PASS for every triggered sub-outcome. Anything else is terminal FAIL. Record the
verdict and end the current run without changing the repository.

## Dispositions at barrier 1

| Disposition | When | Requires |
|---|---|---|
| **fix** | default for a real code or test defect | — |
| **skip** | contradicts a `[D]` or `[ARCH]` rule | the named rule ID |
| **reject — factually wrong** | premise is false | cited code or ticket fact |
| **reject — out of scope** | real but belongs elsewhere | approved exclusion or ticket key |
| **human waiver** | an `[NN]` rule would bend | stop for the user's decision |

A record finding has no repair disposition inside REVIEW. A finding contradicting
an `[NN]` rule is never skipped.
