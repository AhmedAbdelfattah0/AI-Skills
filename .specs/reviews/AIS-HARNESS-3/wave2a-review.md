# Wave 2a review (ba560d5 + repair 9c1dd14), threat model: accidental/buggy workers only

- Round 1 (ba560d5): Opus FAIL (cross-unit re-check loop invisible to the storm guard); Codex FAIL (post-freeze self-writing check loops; unitless dependency change leaves unit verified; unit id `constructor` crashes). All fixed in one repair batch 9c1dd14 (343/343 twice, validate OK).
- Confirmation (9c1dd14): Opus PASS (all prior findings reproduced as fixed; golden byte-identical). Codex FAIL: one new major: a buggy check can change a unitless upstream node's declared contract and still verify its dependent unit, because the mutation watcher excludes unitless paths and evidence is bound after the check (engine-units.mjs:223,:240).
- Policy: one repair + one confirmation used. Owner decision (2026-11-08): disclose as a known limit and fix it first in Wave 2b (same code), covered by 2b's own review; no extra round.

Known limit (2a): unit check mutation detection covered declared paths of units only, not unitless upstream nodes. Fixed in Wave 2b-i: checks are compared against every node's declared paths and the base commit (Codex repro is a test).
Minor (Opus): once-per-command check limit can delay a post-repair re-check by one extra drive (safe; gate still refuses while unverified).
Earlier minors still open: unit with no checks verifies vacuously (documented); evidence covers declared reads/writes only (documented); clearing path for unit_check_failed / unit_invalidation_storm: built in Wave 2b-i (`clear-unit` + owner `UNIT_CLEAR`).
