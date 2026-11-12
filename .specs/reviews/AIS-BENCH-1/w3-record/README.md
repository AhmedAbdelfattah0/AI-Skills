# AIS-BENCH-1 W3-record bench results

`scenarios.json` is the output of `node skills/ship-ticket/scripts/engine-bench.mjs --scenario all --json`, run alone on a quiet machine after the W3-record engine changes.

## What changed in S8

S8 keeps its four baseline rows unchanged. A fifth row, `audit_record_enabled`, runs the same kind of review inputs in a world whose DAG config sets `auditRecord: true`:

- the persisted config is asserted to carry `auditRecord: true`;
- the primary-PASS-with-a-`fix`-finding refusal is still `outcome_inconsistent` (same reasons);
- the accepted record keeps `outcome` (the primary's PASS, equal to `primary_outcome`) and also `primary_outcome` PASS, `second_opinion_outcome` FAIL, the second-opinion identity and the reconciliation summary;
- the GATE events of both reviews carry `review_execution`, and the accepted one the submitted outcomes; the refused one its reasons;
- every event carries `at`;
- `reader_can_reconstruct` is computed from the fields found in the persisted state (it was `false`-equivalent in the baseline row 2, where the second-opinion verdict was absent).

## Comparison with wave-2c

S1-S7, S9 and S10 equal `wave-2c/scenarios.json` except `wall_ms`. `reference_bytes` is identical for all ten (`harness-internals.md` is on demand and not part of any shape). S8's baseline `shows` rows are identical; its metrics (commands, bytes read, nodes completed) rise because the new row builds one more world.

## Limits

- One run each; `wall_ms` is not a comparison.
- The row exercises one review shape (original, second opinion FAIL not applicable). Confirmations and `ended_at` are covered by engine tests, not by the bench.
- Timestamps are snapshot-preparation time, so they order events but do not time decisions.
