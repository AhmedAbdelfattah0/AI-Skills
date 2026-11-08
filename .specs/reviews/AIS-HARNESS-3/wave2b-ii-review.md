# Wave 2b-ii review (977c12a + repair dba96a4), threat model: accidental/buggy workers only

- Round 1 (977c12a): Opus FAIL (2 majors: dependent unit's confirmation absorbs an unreviewed upstream repair; ceiling-refused FAIL left no trace). Codex FAIL (4 majors: reservation not real, crash strands binding, carrier authorizes terminal FAILs, reviewer roles unenforced). Repaired in one batch dba96a4 (368/368 twice).
- Confirmation (dba96a4): Opus PASS (all six fixed; held-slot behaviour is documented and ends at an owner decision, not a deadlock). Codex FAIL: (a) held-slot: an unrelated unit's re-check can raise a durable parent_ceiling while another unit holds slots, halting all dispatch including that unit's own repair; (b) NEW major: a unit declaring a directory (`src`) whose repair writes `src/a.txt` is wrongly marked unbound (engine-unit-review.mjs:301, `under('src',['src/a.txt'])` false).
- Policy: repair + confirmation used. Owner decision (2026-11-08): authorize ONE small RETRY for (b) only; (a) disclosed as a known limit (mitigation: raise config.unitRecheckCeiling for multi-unit tickets), to be reconsidered with A/B data.

Open minors: crash while a unit repair worker runs releases its hold early and the repair ends unbound (safe, existing crash handling); ceilingReached message says "already spent" for held slots; re-review FAIL refused for lack of room records without spending a slot (terminal).

## Owner-authorized RETRY (d505b1d, directory binding)
- Opus PASS (371/371, golden byte-identical, nested/new subdir/delete/rename bind; outside-set changes still unbound).
- Codex FAIL: a repair that changes an existing declared directory's permissions (0755->0700) still binds, because the ancestor exemption covers any changed directory (engine-unit-review.mjs:315-316). Rare. Retry used; disclosed as a known limit. Fix later: restrict the ancestor exemption to directory creation/removal.
- Opus minors: (1) stored per-file tree has no size cap (about 0.9 MB for 10,000 files; node_modules in a declared dir could reach several MB per state save); (2) a declared directory missing at the FAIL gets no tree, so a repair creating files in it is unbound (over-conservative, safe).
Known limits carried out of Wave 2: held-slot ceiling behaviour; directory-permission binding; tree size cap; Windows unsupported.
