# Engine guarantees and limits

What the execution engine in `skills/ship-ticket/scripts/` guarantees, under which conditions, and
where its edges are. For the capability overview see [adaptive-execution.md](adaptive-execution.md).

## When the guarantees apply

The guarantees apply when the orchestrator drives a run through `run-engine.mjs`. The skill also
documents a hand-run flow that uses the same scripts one at a time (SKILL.md, execution-harness.md).
In a STANDARD run the orchestrator records which path it took with a warning; an ELEVATED run waits for
the person. The engine cannot tell who approved a plan: approval is the host's plan mode, and the
engine binds that approval to a digest. Reviewer identities are checked for distinctness, and the
orchestrator is the party that runs reviews; the engine never dispatches REVIEW.

## Refusal codes

| Code | Meaning |
|---|---|
| `approval_mismatch` | The plan no longer matches the digest in the START event. |
| `dag_mismatch` | The task graph differs from the one bound at approval. |
| `dispatched_before_red` | A production node was dispatched before its required RED was accepted. |
| `missing_risk_evidence` | A risk label's evidence kinds are not all present at ship-ready. |
| `missing_local_proof` | The engine's own re-run of the plan's test commands did not pass. |
| `missing_second_opinion` | No second-opinion record. |
| `reviewers_not_distinct`, `reviewer_is_builder` | Recorded identities collide with each other or with a builder. |
| `stale_candidate` | A review names a candidate other than the frozen one. |
| `confirmation_spent`, `round_limit` | A second confirmation or second review repair was requested, or a `prove`-kind repair item exceeded the engine backstop (no production path enqueues one; routine PROVE correction follows the progress rule in the spine). |
| `ownership_violation`, `repair_outside_findings` | A worker wrote outside its declared set. |
| `post_freeze_drift` | The tree changed after the review freeze beyond covered drift. |
| `budget_stop` | A configured token ceiling is spent. |
| `ADMISSION_REFUSED` (logged) | The estimate-based admission held extra parallel work. |

## Ownership

The engine snapshots the tree before and after each worker and fails the node on a write outside its
declared set. Workers share one working tree, so the write is detected after the worker exits; the
engine does not sandbox or revert it. Worker worktree isolation is deferred.

## Durability and crash model

State writes are atomic, each ticket has a lock, and `resume` reconciles live and dead workers. The
crash suites cover deterministic faults and SIGKILL for accidental or buggy workers, not power loss.
The engine is POSIX. Locks are per run; there are no cross-run locks between two ship-ticket runs on
one host.

## Platform notes

- CLI and harness suites run in CI on ubuntu, macOS and Windows (Node 22). Engine property and
  mutation suites run on ubuntu only, and some engine tests are skipped on Windows.
- Host admission (`host-admit.mjs`) reads macOS kernel signals. On other systems it prints
  `platform_unsupported`, which is not an allow, and the orchestrator checks memory and load itself.
  The level 4 memory-pressure threshold is a pragmatic choice, not a proven safety boundary. The CLI
  does not report provider errors.

## Opt-in features

Risk floor (`.ship-ticket/risk-paths.json`), units, test kinds, token budgets, pinned base and
repository identity apply only to runs and repositories that opt in. Each has its own test suite; none
is exercised on a recorded real ticket.

## Review and reviewer identity

Review identities and the second-opinion `route` are recorded strings; the gate checks presence and
distinctness. Cross-provider diversity is derived by code only for risky unit reviews. The two-cycle
root-cause assessment after a failed confirmation is an agent and owner procedure.

## Telemetry

Run logs and summaries are best effort and are not audit evidence.
