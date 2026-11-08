# Wave 3 review (a419be6 + repair 1b234b9), threat model: accidental/buggy workers only

- Round 1 (a419be6): Opus PASS (375/375; listed ship-ready not rechecking units_consumed as a known limit). Codex FAIL: `gate ship-ready` never compared the final review's units_consumed with current evidence ids (base HEAD moved by an empty commit; byte-identical candidate; old final PASS still reached ship_ready).
- Repair 1b234b9 (378/378 twice): ship-ready revalidates units_consumed on the record that authorizes ship; init refuses unitReview without non-empty config.acceptanceIds; coverage label fixed.
- Confirmation: Opus PASS (378/378, validate OK, golden byte-identical). Codex PASS (static trace; no stale-confirmation regression test in the diff).
KNOWN_LIMITS: ship-ready reports units_consumed_stale before candidate_mismatch / instead of review_not_accepted for a stale FAIL original (refusal either way); no stale-confirmation regression test; coverage gaps A (integration node across two units; closed by Wave 3.5), B (3-unit bench fixture; Wave 4), C (over-review cost unmeasured; Wave 4).
