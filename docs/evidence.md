# Evidence

What has been verified, and how, and what has not yet been exercised. "Tested" means a test file
asserts the behaviour and `validate.yml` runs it. The CI workflow is
[`.github/workflows/validate.yml`](../.github/workflows/validate.yml).

## Verified in CI

| Area | Evidence |
|---|---|
| Skill validator and rule-ID ownership | `node scripts/cli.mjs validate`, job `validate`, ubuntu |
| Library CLI and installer, including collision, backup and `--replace-foreign` | `scripts/cli.test.mjs`, job `cli`, ubuntu, macOS and Windows on Node 22 |
| Engine harness suites (gates, run engine, carrier, brief, candidate id, host admission, wording tests) | Job `harness`, ubuntu, macOS and Windows on Node 22; some engine tests are skipped on Windows |
| Engine property, seeded and mutation suites | Job `engine-properties`, ubuntu only |
| `vapt` control catalog consistency | `skills/vapt/controls.test.mjs` |
| Review-rounds ledger for this repository's pull requests | `scripts/review-rounds.test.mjs` |

## Covered by tests, not yet exercised on a real ticket

Digest binding, the RED gate, the review and ship-ready gates, ownership detection, crash resume,
candidate integrity, budgets and the opt-in risk floor, units and test kinds. The suites assert the
behaviour; no clean engine-driven ticket on a real repository has yet been recorded.

## Real-workflow evidence

One partial run record on a real product repository is kept in `.specs/reviews`. It is n=1, covers a
baseline arm only, and is not a clean engine-gated run: after the first review FAIL, the repair and
later events were recorded by hand. A first real ticket also exposed the defect closed as issue 8 in
[KNOWN-ISSUES.md](../KNOWN-ISSUES.md). The repository's own development records are under `.specs/`.

## Not yet exercised

| Area | Status |
|---|---|
| Same-provider second-opinion route | Procedure and tests; no recorded run |
| `vapt` attacks on a real target | Procedure and tests; no committed run artifact |
| Security control selection | The repository's measurement did not show useful selection; no precision claim |
| Sprint intake and wave queue | Dry run and cold-resume test; not a live multi-wave run |
| Azure DevOps | Documented; not exercised end to end |
| Unattended driver | None exists; extended run is a supervised procedure |
| `nn-guard` | Embedded script text; the generated hook and CI job are not run by this repository's CI |

## Not measured

Cost, token or time savings. Token usage is recorded from provider reports, and the plan's fixture
benchmark has not been compared on a real ticket, so no saving is quoted
([execution-harness.md](../skills/ship-ticket/references/execution-harness.md)).
