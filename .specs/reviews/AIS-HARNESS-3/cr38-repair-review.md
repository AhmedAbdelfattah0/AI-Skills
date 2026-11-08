# CodeRabbit PR #38 repair review record

Scope: 72 CodeRabbit comments validated against HEAD c93087c (12 already fixed, 7 not-a-defect, 6 out of scope for the threat model, 47 open-valid; of those 4 duplicates). Repair 38e98e5 fixed 39 (3 Majors, Minors, doc/test nits); the rest are listed below. Verdict policy as Wave 3.5.

## Round 1 (38e98e5)
- Opus primary: PASS. Majors 4505924540 (proof bound to a changed tree), 4505924571 (failed final-review repair now a `repair_failed` judgment), 4507607914 (final confirmation honours the second opinion) verified fixed, not over-fixed; the 28 new tests fail on c93087c; the two updated tests pinned buggy behaviour.
- Codex: FAIL (one finding, P1): after a unit check drifts the approval binding the same drive could still dispatch a dependent node or pending repair (no shipping possible; every gate re-checks). Opus listed the same gap as non-blocking N1.

## Repair (5ba86ac), one batch
`bindingHeld(transient)`: no node or repair dispatch while a binding judgment is held; test failed first on 38e98e5 ("1 !== 0"); oracle P1 assertion added.

## Confirmation
Opus PASS, Codex PASS (Codex static + in-memory probes only). Orchestrator ran the suite: 434 tests, 433 pass, 1 skip; `cli.mjs validate` passes; builder ran ENGINE_MUTATION: 8/8 caught on their own property.

## Not fixed (disclosed)
- Owner-pending: stale cycle loses its hold on edit-and-revert (4507604524, dup 4507607928/4507607898); frozen P12 wording (4507607893); `allowApiBilling` CLI flag (billing-sensitive, doc corrected only, 4505924575); evidence symlink hardening (4507607923); library-only or narrow: 4505921056, 4505924508, 4505924569.
- No test covers the `runRepairs` guard added in 5ba86ac (correct by reading; deleting it would not fail a test).
- Notes from Opus: RED formats without locations now refuse same-named tests in different files as `spec_missing`; symlink fingerprint format changed (branch-only); `architecture` is not a detectable risk label and ticket-level `config.riskLabels` do not trigger the second-opinion requirement.
