# REVIEW — one discovery wave, one repair barrier, one terminal verdict

Loaded when REVIEW starts. Pass B's CLI contract lives in
[codex-cli.md](codex-cli.md).

## The shape

```text
record     sweep once, repair once if needed, freeze the evidence prefixes
F0         snapshot the complete candidate and frozen record
round 1    pass A + pass B + pass C, mutually blind and report-only
barrier 1  reconcile; stop on F0 record defects; seal impact slices; repair once; build optional F1
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

Before any such stop returns control, append every available schema-defined
finding, disposition, outcome and the `REVIEW_CONCLUDED` event. A terminal verdict
is absent when its reviewer was never reached; the stop record does not invent it.

**One write vocabulary.** A **candidate mutation** is any change to a candidate
file or to a plan, parity or VAPT prefix that REVIEW freezes at `F0`. Required
append-only run-state entries are not candidate mutations: they remain permitted
until their stated cutoff so the run can record every finding, disposition,
outcome, timing and stop without rewriting a reviewed prefix.

## Sweep the record once, then close it

Derive `mutation_round` by the spine's sole definition **before the first candidate
mutation**. Repository formatters and generators perform candidate mutations:
running them first, as an apparently neutral tidy-up, spends mutation 4 before
the budget is ever read. A value of 3 ends the run here. Otherwise run them, and
attribute their output to the same pre-`F0` record batch as the sweep below — it
is one batch, not two.

Then sweep the ticket-owned record in one pass:

- the plan and its metadata;
- parity and VAPT artifact prefixes;
- changed comments and docblocks;
- ticket-produced docs;
- manually maintained counts and enumerations;
- citations that claim to describe the candidate.

Prefer stable symbols, selectors, rule IDs, test names, route names and manifest
IDs. Replace hand counts with lists or derived presentation values.

If the sweep requires a repair, it joins the pre-`F0` batch already opened above
rather than opening a second one: every candidate mutation before the freeze —
formatter output, generator output and the record repair — is one batch with one
base-shape `batches[]` entry, because it is one pass over the record and the
budget counts passes. The budget was read before the first mutation and is not
re-derived here. Then hash the plan, parity and VAPT evidence prefixes and
make them immutable. Candidate comments, docblocks and ticket-produced docs stay
ordinary `F0`-manifested paths; barrier 1's sealed exception for a repair-induced
false claim is defined below.

**What the hashed prefixes cover, and what they deliberately do not.** The plan's
prefix stops above the delimited **run-state block**; the parity and VAPT evidence
artifacts are frozen in full. Those three evidence prefixes have no post-`F0`
mutation route. Candidate comments, docblocks and ticket-produced docs are swept
for truth here but are not evidence prefixes. Findings, dispositions, reviewer
conclusions and verdicts arise after the freeze and therefore live only in the
plan's run-state block; no frozen prefix claims to contain them.

**Every field in it is append-only.** Each is a list, each entry is written once
and never edited, and a value that "changes" is a new entry — which is what makes
a later write provably not a rewrite of something already reviewed:

Physically, append one UTF-8 JSON object per line immediately before
`RUN-STATE:END`. Every object carries `type` and `run_id`; `type` is the singular
list name below (`run`, `batch`, `reviewer`, `manifest`, `finding`, `disposition`,
`outcome`, `timing`, `degradation`). Each conceptual array is the ordered
projection of its type. Never replace or reorder an existing line.

```text
runs[]           one START per human-approved execution: run ID, approved-plan
                 digest, approval identity and timestamp; later REVIEW_CONCLUDED
                 or SHIP_READY events carry the same run ID and their reason/state
batches[]        one per candidate-changing repair: phase, purpose, changed_paths[],
                 validation[]; a REVIEW_BARRIER_1 entry additionally carries
                 source_manifest_id, candidate_manifest_id, fix_packet_digest,
                 record_impact_evidence[] and record_impact_evidence_digest
reviewers[]      one per round-1 dispatch: pass, identity, dispatch ID
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
barrier-1 repair has a fix packet, so only that batch entry carries its digest and
durable record-impact evidence. Each `record_impact_evidence[]` item is the sealed
slice entry copied without omission: `record_impact_id`, path, kind, stable
anchor, claim, `f0_bytes` as an RFC 4648 base64 object, `f0_digest`,
`f0_truth_evidence` and causal code/test change-unit ID. Its evidence digest uses
the manifest serialization over the ordered list. Decoding each `f0_bytes` object
must reproduce the bytes hashed by its `f0_digest`.

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

The final appended `run` `START` selects the active run. The spine's
mutation-budget section is the sole definition of `mutation_round`: count only
that active `run_id`'s batch entries. No artifact carries the count as a field;
this schema stores only the partition key and underlying entries.

After `F0`, any mismatch or change in a plan, parity or VAPT evidence prefix ends
the current run. A candidate prose claim already false at `F0` does too. The only
later prose route is the predeclared repair-induced impact slice in barrier 1; no
correction request opens another sweep or another candidate-mutation barrier.
Historical finding locators stay bound to their source manifest and are not
rewritten to match the candidate.

## Freeze `F0`

The manifest records:

- repository path, branch, `HEAD`, target base and merge base;
- committed, staged, unstaged and untracked state;
- each ordinary candidate path's status, mode, content digest, rename origin and
  deletion tombstone;
- symlink targets, hashed as link-target bytes and never dereferenced;
- submodules either **rejected dirty at the freeze** or manifested **recursively**
  by gitlink OID. A bare dirty bit cannot tell one dirty submodule state from
  another, so it is not a freeze — and a fix packet cannot carry a submodule
  change unit's preimage and postimage without it;
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

`reviewed_content_id` is the `ship-ticket-reviewed-content-v1` SHA-256 digest of
the final candidate's bytewise-sorted `path NUL kind NUL mode NUL final-image`
entries, with deletes represented by tombstones and submodules by gitlink OID,
plus `frozen_record_digest`. Renames are normalized to their deleted and added
paths. It deliberately excludes repository path, branch, `HEAD`, target base,
merge base, committed/staged/unstaged buckets, rename metadata, the plan's
append-only run-state block and the permitted SHIP session-log projection. Those
are repository representation or result fields, not reviewed content. The same
bytes therefore keep the same identity when SHIP turns a working tree into its
single commit. The terminal reviewer returns this ID; SHIP recomputes it before
the commit and every resume.

Recompute `ui_required` and write it before the record sweep and `F0`. Round-1
reviewers receive the identical manifest. No candidate mutation occurs while they
run; required append-only run-state entries remain permitted. Any manifest change
ends the current run; it does not trigger redispatch.

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

Pass C emits one `rule → outcome → evidence` table using the canonical vocabulary
from [ship.md](ship.md), containing every routed
specialist row, every `[NN]` row, separate `AI-FM` and `UNIVERSAL` rows, plus
`TEST` and `DOC` when applicable. A missing inventory may degrade only its
inventory-derived rows; it never removes the whole-diff rows.

The three passes are mutually blind and report-only. Coverage mismatch, a changed
manifest or an unreadable result after its schema correction ends the run.

## Barrier 1 — the only candidate-mutation barrier

In order:

1. Reconcile the three result sets and give every finding one disposition.
2. If any finding concerns a plan, parity or VAPT evidence prefix, or identifies
   candidate prose that was already false at `F0`, append the finding, its
   no-repair disposition, the failed record-check outcome and a `REVIEW_CONCLUDED`
   run event, then end the current run before any candidate mutation. Those
   required append-only entries are permitted by the vocabulary above. This is a
   pre-existing record defect, not a consequence of the repair.
3. Derive `mutation_round` by the spine's sole definition. If it is already 3 and
   a candidate mutation is required, record the stop and end the run.
4. Create a per-run private temporary directory outside the worktree, accessible
   only to the current user. Its `packet.json` is the fix packet carrier and its
   opaque change-unit subpaths hold preimage contents. Failure to create or read
   that carrier ends the run before mutation. Assign stable IDs to the planned
   code/test change units and capture the **contents**, not the digests, of their
   paths and the complete eligible prose corpus into it before mutating anything.
   Step 5 isolates each prose entry's exact bytes from those captured images. The
   manifest holds digests: once an uncommitted file is overwritten its previous
   state is unrecoverable, and the question the packet exists to answer — what
   did this look like before — becomes unanswerable.
5. Before the first candidate mutation, derive the planned code/test units'
   affected caller/contract closure and seal the finite `record_impact_basis`,
   `record_impact_slice[]` and `record_impact_slice_digest` defined below. A slice
   that is unbounded, incomplete, outside the approved Design Contract or unable
   to prove every included claim true at `F0` ends the run under step 2.
6. Apply one sealed candidate repair batch inside the approved Design Contract.
   Apply the planned code/test units, recompute their actual affected closure,
   and require it to remain inside the sealed basis before any prose mutation.
   Then update or delete only a slice entry whose claim that repair actually made
   false, and only through its predeclared causal code/test unit. Code/test
   mutations and their permitted prose consequences are one batch and one barrier.
7. Build `packet.json` in that carrier while changing the files; it cannot be
   reconstructed afterwards from the diff. Pass its absolute path and expected
   digest read-only to the terminal reviewer, then remove the private directory
   after the verdict is appended or the run stops. Once the first candidate
   mutation starts, every stop path must append the barrier batch and its durable
   record-impact projection before that cleanup; it performs no further candidate
   mutation. The packet holds each finding, its disposition, and its
   **change units — not hunks**. A hunk cannot represent an add, a delete, a
   rename, a mode change, a symlink retarget, a submodule move or an untracked
   file, every one of which the `F0` manifest already records. Each change unit
   carries its path, its kind, its preimage (or a deletion tombstone) and its
   postimage. Attribution is many-to-many: each change unit lists the finding IDs
   it serves, and each finding lists its change units.
8. For each UI change, add its dependency-closed parity impact slice:
   changed nodes, selectors, declarations, tokens, states, translation keys and
   affected owned-screen consumers.
9. If the candidate changed, snapshot it as `F1`. Add its
   affected caller/contract closure to the fix packet: changed files, direct
   callers and exposed contracts. With no candidate change, retain `F0` and skip
   to terminal review.
10. **Re-derive `F1`'s boundary records and compare them to PROVE's frozen
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
     required. End the run and name the exact rule IDs and test-body digests
     added or removed. An unchanged name with a changed body lands here.
   - **ID present in both, coverage vector identical, but an implementation or
     control-input digest changed** → re-run that boundary's already-mapped abuse
     tests. Green with recorded evidence continues; red or missing ends the run.
   - **ID, coverage vector and digests identical** → record it unchanged.

   The coverage vector is the bytewise-sorted rule IDs plus the multisets of body
   digests in the positive, refusal and authorization lists. For each list,
   bucket the frozen and repaired IDs by body digest, cancel identical names
   inside each bucket, then pair any remaining old/new names bytewise. Equal
   multiplicity with different names is a rename: append the pairs to
   `renamed_test_ids[]` in the boundary-comparison evidence and continue. A count
   change adds or removes coverage and stops. A test whose body changed under an
   unchanged name changes the digest multiset and therefore lands in the
   coverage-changed branch, exactly as deleting it would. The frozen attack
   evidence was produced against the old body and no longer corresponds to the
   committed test. Re-running would prove nothing here: a weakened test passes
   *because* it was weakened. Digest-first matching closes the name-only false
   stop without requiring consuming repositories to declare another stable ID.

   Human predicate labels are not compared: `admin` and
   `role:admin` cannot create a false stop, and no semantic-equivalence judgment
   is needed. A non-authorization boundary has an empty authorization-test list by
   PROVE's schema.
11. Run only the affected deterministic commands, append the boundary comparison
    and rerun evidence to the fix packet, finalize its digest, and evaluate its
    balance. Whether those checks pass or fail, before terminal dispatch, stop or
    private-carrier cleanup append the
    `REVIEW_BARRIER_1` batch entry, including validation results and the durable
    `record_impact_evidence[]` projection defined above. Require that projection,
    after base64 decoding, to equal the packet's sealed slice entry-for-entry and
    to reproduce its evidence digest. This required run-state append is not a
    candidate mutation or another barrier. **A red command or unbalanced packet
    here ends the run unshipped after its result is recorded.** It is not a finding
    to repair: the barrier has already spent its one repair, and fixing what the
    repair broke is the second repair this phase does not have. "A finding you can
    fix is work" governs BUILD, not a closed barrier.

### The repair-induced prose impact slice

This is the same dependency-closed mechanism as the parity impact slice, applied
to candidate prose and sealed earlier because it grants candidate-mutation authority. It is
not another record sweep.

The allowed corpus is exact and finite: comments and docblocks in **every**
candidate source or test path named by the approved Design Contract, plus every
ticket-produced doc named by that contract. `allowed_paths[]` is the exact
eligible-path projection of the Design Contract against `F0`, not a subset the
repair author chooses. It never includes the plan, the parity artifact, the VAPT
artifact, findings, dispositions, reviewer conclusions, `runs[]` or any other
run-state entry. A required path outside that corpus or contract ends the run; it
does not widen the corpus.

Before the first candidate mutation, enumerate every comment/docblock or document
assertion anchor in those allowed paths as `prose_inventory[]`. Partition that
inventory into `record_impact_slice[]` — every claim whose subject intersects the
planned code/test units' affected caller/contract closure — and
`reasoned_exclusions[]`. The packet records `record_impact_basis` with the `F0`
manifest ID, approved Design Contract digest, exact `allowed_paths[]`, stable
affected symbol/contract IDs, planned code/test change-unit IDs, parser or search
method and inputs, and the ordered inventory IDs. Each exclusion carries its
inventory ID, path, anchor and the reason its claim cannot be affected. The
enumerator must account for every parser-reported comment/docblock range and
every prose assertion segment in a ticket-produced doc; if the repository's
language or document shape cannot be enumerated completely, the slice is
unbounded and the run stops.

Each `record_impact_slice[]` entry has exactly:

```text
record_impact_id
path
kind: comment | docblock | ticket_doc
stable_anchor: enclosing stable symbol/selector/heading plus unique F0 byte span
f0_bytes
f0_digest
claim
f0_truth_evidence
causal_code_or_test_change_unit_id
```

`f0_bytes` is `{ encoding: "base64", value: "..." }`, which reconstructs the
exact byte content rather than merely naming its digest. The identical object,
claim and truth evidence live in both the private packet and the barrier batch's
durable projection. The anchor must resolve exactly once at `F0`; its byte span
prevents a same-symbol ambiguity. Verify the atomic claim against `F0` and record
stable evidence. If the claim is already false, it is the step-2 record finding
and no candidate mutation occurs.

Seal `record_impact_slice_digest` over the basis, ordered inventory, slice and
exclusions under the manifest serialization. Before mutation, require all of the
following mechanically:

```text
prose_inventory ids  ==  slice ids ∪ exclusion ids
slice ids ∩ exclusion ids  ==  ∅
allowed paths  ==  eligible source/test and ticket-doc paths in the Design Contract at F0
enumerated anchors  ==  every parser/document prose range in every allowed path
every inventory id resolves once
every slice causal id resolves to one planned code/test change unit
every slice F0 byte image and digest match F0
```

The digest and those set equalities seal membership before the first candidate
mutation. No entry, path, anchor, causal edge or exclusion may be added, removed,
reordered or replaced afterwards. If the actual repair reaches a subject outside
the sealed affected closure, exposes an omitted claim, or otherwise shows the
slice incomplete, end the run without a prose mutation. In particular, discovering
an omitted entry after code mutation does not authorize a wider nominal batch.

After the code/test units are applied, evaluate every slice claim and decide one
`record_impact_results[]` row per slice ID before touching prose:

```text
record_impact_id
post_code_claim_status: TRUE | FALSE
action: NONE | UPDATE | DELETE
causal_code_or_test_change_unit_id
prose_change_unit_id | none
f1_bytes_or_tombstone
f1_digest_or_tombstone
f1_truth_evidence
```

`TRUE` requires `NONE`. `FALSE` permits `UPDATE` or `DELETE` only when the stated
predeclared code/test unit actually caused the falsification. Each resulting
prose change is an ordinary packet change unit with exact `F0`/`F1` images,
finding attribution, `record_impact_id` and a reciprocal causal edge to that
code/test unit. A merely desirable cleanup, an already-false claim, an unproven
causal edge or a prose change outside the slice ends the run. No prose edit may
start until all rows and intended final byte images have been decided. Apply
exactly those bytes, then require every resulting image and digest to match its
row; once prose mutation starts the slice is still sealed, and there is no second
sweep or repair.

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

The plan, parity and VAPT evidence prefixes remain byte-identical. Candidate
prose changes balance only when they satisfy the sealed slice rules above; their
change units participate in the same four arithmetic checks as every other
change. Reciprocal slice/causal IDs are resolved by the existing referenced-unit
check. An unbalanced packet, an invalid prose slice or an unbounded parity impact
ends the run.

`fix_packet_digest` is the `ship-ticket-manifest-v1` SHA-256 digest over the
packet's findings, dispositions, change units — each with its path, kind,
preimage and postimage — its attribution map, affected closure,
`record_impact_basis`, ordered prose inventory, sealed slice,
`record_impact_slice_digest`, exclusions and results, under the manifest's
serialization. If the candidate did not change there is no packet: use `F0` as
the candidate and record `fix_packet_digest: none`.

## Round 2 — the terminal reviewer

**Run one sighted reviewer independent of the builder. Always — there is no
condition on it.** A run that skipped this would carry no `reviewer_identity` and
no signature, which is the one thing this phase exists to produce. Where the final
candidate is `F0`, the dispatch is cheap: the reviewer is handed the unchanged
manifest and confirms the round-1 result, and that confirmation *is* the verdict.

Give the terminal reviewer:

- the ticket, acceptance criteria and approved scope;
- `F0`, the final candidate manifest, reviewed-content identity and
  frozen-record digest;
- all round-1 findings and dispositions;
- the balanced fix packet and affected caller/contract closure when barrier 1
  changed the candidate; otherwise `none` and `[]`;
- the barrier batch's durable `record_impact_evidence[]` and evidence digest,
  which must reconstruct and equal the packet's sealed slice;
- pass A's complete parity result and any barrier-1 parity impact slice;
- the sealed prose inventory, impact slice, exclusions and result rows when
  barrier 1 changed the candidate;
- the frozen runtime attack evidence.

The reviewer answers:

```text
reviewer_identity
source_manifest_id
candidate_manifest_id
reviewed_content_id
fix_packet_digest | none
frozen_record_digest
frozen_record_status: UNCHANGED | MISMATCH
change_outcome: PASS | FAIL
record_impact_outcome: PASS | FAIL | NOT_TRIGGERED
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

For prose it performs no second sweep and creates no work. It first requires the
durable projection and digest to reproduce the packet's sealed entries. It then
examines the inventory and impact slice once: the actual closure must fit the
predeclared basis; every edited entry must have been true at `F0`, made false by
its exact causal code/test unit, and true or removed at `F1`; every unchanged
slice entry must still be true; every exclusion must still be valid; and no
candidate prose outside the slice may have changed. A projection mismatch,
residual false claim, invalid exclusion that exposes newly false prose, uncovered
causal edge or any other incomplete slice is a terminal finding and
`record_impact_outcome: FAIL`. It is never repaired in this run. With no barrier-1
candidate change the outcome is `NOT_TRIGGERED`.

PASS requires an unchanged frozen record, every applicable check covered or its
documented companion-unavailability degradation declared, no findings and PASS
for every triggered terminal sub-outcome, including the prose impact check.
Anything else is terminal FAIL. Append the returned verdict once to `outcomes[]`;
make no candidate mutation. On FAIL, end the current run.

## Dispositions at barrier 1

| Disposition | When | Requires |
|---|---|---|
| **fix** | default for a real code or test defect | — |
| **skip** | contradicts a `[D]` or `[ARCH]` rule | the named rule ID |
| **reject — factually wrong** | premise is false | cited code or ticket fact |
| **reject — out of scope** | real but belongs elsewhere | approved exclusion or ticket key |
| **human waiver** | an `[NN]` rule would bend | stop for the user's decision |
| **stop — pre-existing record defect** | a plan/parity/VAPT prefix is false or candidate prose was false at `F0` | failed record-check outcome and `REVIEW_CONCLUDED`; no candidate mutation |

A pre-existing record finding has only the stop disposition inside REVIEW. A
sealed repair-induced prose consequence is a causal change unit, not that
disposition.
A finding contradicting an `[NN]` rule is never skipped.
