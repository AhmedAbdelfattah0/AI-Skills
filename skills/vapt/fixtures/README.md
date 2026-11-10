# vapt selection fixtures (version 5)

Thirty-five ticket-like scenarios (`scenarios.json`) with expected control labels
(`labels.json`), split by `manifest.json` into a dev set (14) and a sealed set (21).
Each scenario has a summary, changed surfaces, and the facts defined by
`fact_vocabulary` in `../controls.json`. Four scope-exceeds-plan scenarios add
planned facts and `actual_diff_signals` from a fixed vocabulary (`none` only alone).

## Labels

- `must_select`: controls a selector must return, each with a rationale, each
  reachable from the scenario facts through the catalog evaluator. Non-low-risk
  scenarios have a non-empty `must_select`.
- `inapplicable`: controls that clearly do not apply; every label states an
  `inapplicable_basis`. Low-risk labels add `exceptions` so that `inapplicable`
  plus the exception keys are exactly the 25 controls. Other controls are unlabeled.
- A control is never inapplicable while one of its own `primary_facts` is true or
  unknown, except VAPT-ABUSE-07 via `persistent_write`, which the catalog selects on
  any persistent write on purpose; those cases stay visible in the ledger.

## Computed ledger (`disagreements.json`, written by `make-ledger.mjs`)

- `entries`: computed, see `disagreements.json` (47 at the v5 seal). Inapplicable
  labels the catalog selects anyway, with `via`. Expected catalog over-breadth cost.
- `broad_gate_only_required`: required ABUSE labels whose primary facts are all
  false, so only the broad business-invariant or auth-lifecycle gate reaches them.
  If those gates narrow later, these labels are the first catalog-misses to review;
  they must not be dropped silently.
- `reassess`: per scope-exceeds-plan scenario, `delta` = selected(actual facts)
  minus selected(planned facts), `added_in_delta`, and `already_planned`.
The test recomputes every section and requires an exact match.

## Scoring (once `select` exists)

- Recall of `must_select` per control, category and family, always as counts.
  Recall measures implementation fidelity to the catalog, not catalog completeness
  or security improvement. A score at or near the catalog-faithful baseline
  (`manifest.preregistered_baselines`, recomputed by the test) is expected and
  proves nothing about security.
- Hard defect: an inapplicable violation pair (scenario, control) not in the
  ledger; net hard defects = violation pairs not in the ledger. Unlabeled controls
  a selector returns are reported separately as breadth, never as errors or hits.
- Reassess: verdict match plus recall of `added_controls` ∩ `delta` only. The
  labeler's `added_controls` are semantic hints; entries already planned under the
  over-selecting catalog are not scored. There is no ADD_CONTROLS fixture.
- Dev scenarios may be used to tune predicates. Sealed scenarios may not.
- Results on this set are reported as implementation fidelity only. No claim of
  security improvement or generalization is made until a non-StoreCraft,
  independently sealed corpus is scored.

## Provenance and limits

- Sealed is only weakly independent: its author saw `fact_vocabulary.json`, whose
  examples derive from the audit, and reviewers and the orchestrator saw the sealed
  set at each reseal. Dev derives from the audit (12 audit-derived, 2 synthetic).
- This measures facts to controls, not fact extraction from a diff.
- `provenance/` holds what the author and labeler saw. Fact amendments: rounds 1-3
  (`amendments.json`, `amendments_round2.json`, `amendments_round3.json`); label
  changes from v3 to v4 are in `label_history.json`.

## Seal anchor and re-sealing

The seal is anchored only by git history: the commit that first contains manifest
version 5 is the anchor (`manifest.seal_anchor`; the v4 anchor was `2ca3647`). Moving a
scenario between dev and sealed and re-hashing passes the tests, so reviewers must diff
`manifest.sets` and the scenario origins between commits. The catalog evaluator exists
once, in `../controls.mjs`; `selector.mjs` re-exports it (`unknownish`, `assertFacts`,
`holds`, `via`, `why`, `selected`) and `fixtures.test.mjs` checks object identity and
that no local copy is declared. After any label or catalog change, run
`node skills/vapt/fixtures/make-ledger.mjs`; a `controls.json` change also needs a
new `catalog_digest_at_seal`, a `history` entry, and stale prior sealed results.
