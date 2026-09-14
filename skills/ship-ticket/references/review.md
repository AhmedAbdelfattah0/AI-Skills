# REVIEW — one discovery wave, one repair barrier, one terminal verdict

Loaded when REVIEW starts. Pass B's CLI contract lives in
[codex-cli.md](codex-cli.md).

## The shape

```text
record     sweep once, repair once if needed, freeze the reviewed prefixes
F0         snapshot the complete candidate and frozen record
round 1    pass A + pass B + pass C, mutually blind and report-only
barrier 1  reconcile; stop on record findings; repair code/tests once; build optional F1
round 2    one sighted independent reviewer returns the terminal verdict
PASS       continue to SHIP
FAIL       end the current run unshipped
```

Round 2 replaces the old fix-review wave, repeated A/B passes, separate parity
attestation and separate security attestation. It never creates candidate work.

Append the REVIEW-start entry to `timings[]` before any availability check, record
sweep or dispatch. It is the durable point of no return for the current run. Once
that entry exists, **every stop named below ends the run unshipped**, even when it
happens before a terminal verdict can be returned. The spine's resume table tests
this entry, not verdict absence.

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

If the sweep requires a repair, derive `mutation_round` by the spine's sole
definition before writing. A value of 3 ends the run; otherwise apply one record
repair batch and append its base-shape `batches[]` entry. Then hash each reviewed
prefix and make it immutable.

**What the hashed prefixes cover, and what they deliberately do not.** They are
the pre-`F0` candidate narrative: each claim, count and citation about the tree
that a reviewer must be able to check. In the plan, that prefix stops above the
delimited **run-state block**; the parity and VAPT evidence artifacts are frozen in
full. Findings, dispositions, reviewer conclusions and verdicts arise after the
freeze and therefore live only in the plan's run-state block; no frozen prefix
claims to contain them.

**Every field in it is append-only.** Each is a list, each entry is written once
and never edited, and a value that "changes" is a new entry — which is what makes
a later write provably not a rewrite of something already reviewed:

Physically, append one UTF-8 JSON object per line immediately before
`RUN-STATE:END`. Every object carries `type`, whose value is the singular list name
below (`batch`, `reviewer`, `manifest`, `finding`, `disposition`, `outcome`,
`timing`, `degradation`); each conceptual array is the ordered projection of its
type. Never replace or reorder an existing line.

```text
batches[]        one per candidate-changing repair: phase, purpose, changed_paths[],
                 validation[]; a REVIEW_BARRIER_1 entry additionally carries
                 source_manifest_id, candidate_manifest_id and fix_packet_digest
reviewers[]      one per round-1 dispatch: pass, identity, run ID
manifests[]      one per snapshot: label (F0 | F1), manifest ID
findings[]       one per round-1 finding: stable ID, source pass and source locator
dispositions[]   one per finding: finding ID, disposition, concise reason and
                 supporting rule ID or stable locator
outcomes[]       one per post-F0 check result, plus the terminal verdict as one entry
timings[]        one per phase boundary: phase, event, timestamp
degradations[]   one per unavailable companion or execution capability
```

PROVE and the pre-`F0` record sweep use the base `batches[]` shape. They have no
fix packet, store no sentinel for one and never gain a digest later. Only the
barrier-1 repair has a fix packet, so only that batch entry carries its digest.

**The prefix/block split is about WHO may change a line, not about how it reads.**
Entries here carry words — a changed path, a disposition, a rule ID — and that is
fine: what disqualifies text from this block is not being prose but being a
pre-`F0` claim about the candidate that can go stale. A record of what the run did
or what a reviewer concluded belongs here, is written once, and can never drift
because nothing later rewrites it.

`dispositions[]` holds the complete reason the terminal reviewer must weigh,
including rejected findings that produce no repair packet. A fix packet adds the
causal mapping from accepted findings to changed bytes; it is not the sole home of
disposition reasoning.

The spine's mutation-budget section is the sole definition of `mutation_round`.
No artifact carries it as a field; this schema stores only the underlying batch
entries.

A post-`F0` record mismatch, narrative edit or correction request ends the current
run. Historical finding locators stay bound to their source manifest; they are
not rewritten to match the candidate.

## Freeze `F0`

The manifest records:

- repository path, branch, `HEAD`, target base and merge base;
- committed, staged, unstaged and untracked state;
- each ordinary candidate path's status, mode, content digest, rename origin and
  deletion tombstone;
- symlink targets and dirty submodule state;
- reviewed paths and reasoned exclusions;
- `design_ref`, owned screens and attack surfaces;
- each artifact's immutable-prefix digest;
- deterministic `ship-ticket-manifest-v1` SHA-256 ID.

The plan artifact is the one structured-path exception to whole-file candidate
hashing. Its immutable prefix digest participates in `manifest_id`; its run-state
block does not. The block is verified separately as ordered append-only JSON
lines, so a schema-valid new result entry leaves the candidate ID unchanged while
an edit, deletion or reorder of an existing entry fails verification. Parity and
VAPT artifacts have no such block and remain whole-file frozen. This replaces
whole-file hashing for the plan path only.

`frozen_record_digest` is the `ship-ticket-manifest-v1` SHA-256 digest of the
bytewise-sorted `path NUL prefix-digest` pairs for the plan, parity and VAPT
artifacts that exist. This is the single binding the terminal reviewer returns;
the per-path digests remain its inspectable inputs.

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

**Concurrent dispatch is a required capability, and its absence is a stop — not a
slower mode.** Running A, B and C one after another costs roughly three times the
wall clock for exactly the same coverage and the same findings. That is the
six-hour REVIEW this phase was rebuilt to end, so serial execution is not offered
as a degraded path: an orchestrator that cannot fan out ends the run unshipped
and records

> ⛔ REVIEW stopped: this agent cannot dispatch A, B and C concurrently. Serial
> round 1 costs their summed wall clock rather than the longest pass, which
> abandons the ~20-minute target for identical coverage. Re-run REVIEW on an
> orchestrator that can fan out.

as a `degradations[]` entry. Nothing about coverage is at stake here and no
judgment is involved; the only thing serial execution buys is time spent. Round 2
has one reviewer and therefore has no orchestration mode.

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
3. Derive `mutation_round` by the spine's sole definition. If it is already 3 and
   a write is required, end the run.
4. Capture preimages — the **contents**, not the digests — of every file the
   repair will change, before mutating anything, and store them outside the
   worktree. The manifest holds digests: once an uncommitted file is overwritten
   its previous state is unrecoverable, and the question the packet exists to
   answer — what did this look like before — becomes unanswerable.
5. Apply at most one code-and-test repair batch inside the approved Design
   Contract.
6. Build the fix packet while changing the files; it cannot be reconstructed
   afterwards from the diff. It holds each finding, its disposition, and its
   **change units — not hunks**. A hunk cannot represent an add, a delete, a
   rename, a mode change, a symlink retarget, a submodule move or an untracked
   file, every one of which the `F0` manifest already records. Each change unit
   carries its path, its kind, its preimage (or a deletion tombstone) and its
   postimage. Attribution is many-to-many: each change unit lists the finding IDs
   it serves, and each finding lists its change units.
7. For each UI change, add its dependency-closed parity impact slice:
   changed nodes, selectors, declarations, tokens, states, translation keys and
   affected owned-screen consumers.
8. If code or tests changed, snapshot the repaired candidate as `F1`. Add its
   affected caller/contract closure to the fix packet: changed files, direct
   callers and exposed contracts. With no candidate change, retain `F0` and skip
   to terminal review.
9. **Re-derive `F1`'s boundary records and compare them to PROVE's frozen
   inventory by `boundary_id`.** A repair can add or move a route, middleware,
   rendering sink, outbound call or security configuration after the attacks ran.
   Use PROVE's record shape exactly; do not invent predicate aliases.

   Partition the IDs first, then apply exactly one branch:

   - **Added ID, or an ID that cannot be derived** → new boundary. End the run
     unshipped and name it; the required abuse test would be a second repair.
   - **Removed ID** → record its tombstone and the affected caller/contract closure;
     it adds no attack coverage requirement. Any paired replacement also appears
     in the added-ID branch and therefore stops.
   - **ID present in both, coverage vector changed** → new attack coverage is
     required. End the run and name the exact rule and test IDs added, removed,
     or changed in body.
   - **ID present in both, coverage vector identical, but an implementation or
     control-input digest changed** → re-run that boundary's already-mapped abuse
     tests. Green with recorded evidence continues; red or missing ends the run.
   - **ID, coverage vector and digests identical** → record it unchanged.

   The coverage vector is the bytewise-sorted rule IDs and positive, refusal and
   authorization test IDs, each test ID being PROVE's name-plus-body-digest pair.
   A test whose body changed under an unchanged name therefore lands in the
   coverage-changed branch and ends the run, exactly as deleting it would —
   because it is the same act. The frozen attack evidence was produced against
   the old body and no longer corresponds to the committed test. Re-running would
   prove nothing here: a weakened test passes *because* it was weakened. This is
   deliberate rather than a false stop, and it is the one branch that catches a
   repair which fixes the proof instead of the code.

   Human predicate labels are not compared: `admin` and
   `role:admin` cannot create a false stop, and no semantic-equivalence judgment
   is needed. A non-authorization boundary has an empty authorization-test list by
   PROVE's schema.
10. Run only the affected deterministic commands, append the boundary comparison
    and rerun evidence to the fix packet, then balance it.

**To balance is to satisfy all four of these, arithmetically and without
judgment.** The spine makes an unbalanced packet a stop; this is what it means:

```text
every change unit between F0 and F1  ==  the union of all attributed change units
every referenced finding id resolves · every referenced change unit resolves
every preimage matches F0 · every postimage matches F1
```

"An unattributed fix is itself a finding" detects nothing if the executor simply
omits the attribution. The balance check is what makes it real. The cases that
break naive attribution, and their answers:

| Case | Answer |
|---|---|
| a changed file no finding named | allowed **if** it is inside the approved Design Contract and carries a stated causal reason; outside the contract it is a material divergence that ends the run, not an attribution problem |
| a rejected finding carrying change units | the rejection was not a rejection |
| formatter or generator output | attributed as a mechanical consequence of the change that triggered it, or reverted before the packet closes |
| a change serving no finding at all | **the balance check fails** — that is the hole this packet exists to close |

Record text, comments, docblocks and artifact prefixes remain unchanged. An
unbalanced packet or an unbounded parity impact ends the run.

`fix_packet_digest` is the `ship-ticket-manifest-v1` SHA-256 digest over the
packet's findings, dispositions, change units — each with its path, kind,
preimage and postimage — and its attribution map, under the manifest's
serialization. If no code or test changed there is no packet: use `F0` as the
candidate and record `fix_packet_digest: none`.

## Round 2 — the terminal reviewer

**Run one sighted reviewer independent of the builder. Always — there is no
condition on it.** A run that skipped this would carry no `reviewer_identity` and
no signature, which is the one thing this phase exists to produce. Where the final
candidate is `F0`, the dispatch is cheap: the reviewer is handed the unchanged
manifest and confirms the round-1 result, and that confirmation *is* the verdict.

Give the terminal reviewer:

- the ticket, acceptance criteria and approved scope;
- `F0`, the final candidate manifest and frozen-record digest;
- all round-1 findings and dispositions;
- the balanced fix packet and affected caller/contract closure when barrier 1
  changed the candidate; otherwise `none` and `[]`;
- pass A's complete parity result and any barrier-1 parity impact slice;
- the frozen runtime attack evidence.

The reviewer answers:

```text
reviewer_identity
source_manifest_id
candidate_manifest_id
fix_packet_digest | none
frozen_record_digest
frozen_record_status: UNCHANGED | MISMATCH
change_outcome: PASS | FAIL
parity_outcome: PASS | FAIL | NOT_TRIGGERED
attack_review_outcome: PASS | FAIL | NOT_TRIGGERED
security_outcome: PASS | FAIL | NOT_TRIGGERED
findings[]
overall_outcome: PASS | FAIL
```

`NOT_TRIGGERED` is valid only when the corresponding plan/diff trigger is false;
in particular, a security-sensitive run must return `security_outcome: PASS |
FAIL`.

For each repaired or rejected finding it decides whether the finding was real,
whether the disposition was correct, whether the repair addressed it and whether
the repair caused a regression.

It does not repeat pass A, pass B, pass C or the attacks — barrier 1's boundary
comparison is what guarantees the repair introduced no surface the frozen attack
evidence never covered. For parity it consumes the complete `F0` comparison and
checks only the recorded impact slice against the pinned reference. For security
it reviews the runtime evidence that PROVE already generated.

PASS requires an unchanged frozen record, every applicable check covered or its
documented companion-unavailability degradation declared, no findings and PASS
for every triggered terminal sub-outcome. Anything else is terminal FAIL. Append
the returned verdict once to `outcomes[]`; make no code, test or frozen-narrative
change. On FAIL, end the current run.

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
