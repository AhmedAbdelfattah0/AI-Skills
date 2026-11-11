# AIS-BENCH-1 Wave 1 — baseline (GitHub issue #53)

Recorded on 2026-11-11 from `main` at `65b84cd` plus the measurement code this wave adds
(`load-record.mjs`, `engine-bench-scenarios.mjs`) or extends (`engine-bench.mjs`), all under
`skills/ship-ticket/scripts/`. Nothing under `skills/ship-ticket/references/` and no engine
file differs from `main`, so these numbers describe the library as it was before Wave 2.

| File | Produced by |
|---|---|
| `load.json` | `node skills/ship-ticket/scripts/load-record.mjs --json` |
| `scenarios.json` | `node skills/ship-ticket/scripts/engine-bench.mjs --scenario all --json` |

Both files are script output and are not edited by hand. Run the same two commands from the
repository root to reproduce them. Every figure except `wall_ms` is the same on every run
(checked over three runs).

## Limits (read these before using a number)

- **The provider is fake.** The bench shows mechanism and orchestration overhead only. It says
  nothing about model quality, first-pass rate or review findings.
- **Wall time is one sample from one machine** (macOS 26.5.2, Apple M4 Pro, 12 cores, Node
  22.23.1). `wall_ms` differs from run to run. The tests assert counts, refusals and judgments,
  never time.
- **POSIX only.** On Windows every scenario is skipped (known quiescence limit N7), and
  `engine-bench.mjs --scenario` exits 1 there.
- **Run the engine suites one at a time** (issue #49): several copies at once give false
  failures.
- **Real-ticket figures are not here.** They come from `eval.mjs report` on real tickets, with
  `archive` run before a work tree is removed. With one or two runs per arm they are
  observations, not proof of a difference.
- **The unit-text figure is a lower bound.** It counts whole sections whose heading names units
  (listed in `load.json`), not unit sentences inside other sections.

## What the orchestrator loads (`load.json`)

| Measure | Value |
|---|---|
| Spine (`SKILL.md`) | 42,072 bytes |
| Spine plus every reference | 266,053 bytes in 12 files |
| A full run (workflow start to SHIP) with no optional condition, without units | 9 files, 242,509 bytes |
| The same run with units | the same 9 files, 242,509 bytes |
| A run with every condition (UI, security-relevant, elevated counterpart, Codex) | 12 files, 266,053 bytes |
| Opt-in unit text inside `references/execution-harness.md` | 14,986 bytes (1 section) |
| Opt-in unit text inside `references/review.md` | 10,373 bytes (3 sections) |

A run without units loads the 25,359 bytes of unit text all the same, because that text sits in
two files every run loads. The per-phase load sets are in `load.json` under `phases`.

`load-record.mjs` reads the load table in `SKILL.md`. A row it does not recognise makes it
fail, so a change to the table has to be reflected in the script before it can be measured.

## The seven scenarios (`scenarios.json`)

| # | Scenario | What the run showed | Commands | Bytes read | Reference bytes | Judgments | Owner interventions | Proof runs | Retries |
|---|---|---|---|---|---|---|---|---|---|
| S1 | One node | completes with `init` and `drive` | 2 | 811 | 242,509 | 0 | 0 | 0 | 0 |
| S2 | Contract, then frontend and backend, then a join | three waves in order: the contract, then frontend and backend together (peak concurrency 2), then the join | 2 | 1,077 | 242,509 | 0 | 0 | 0 | 0 |
| S3 | Auth-sensitive change | with the spec evidence supplied, ship-ready reports `authorization-spec` and `negative-spec` missing until RED is accepted; after RED the `missing_risk_evidence` reason clears with the evidence and returns without it | 7 | 3,226 | 255,066 | 0 | 0 | 1 | 0 |
| S4 | Six nodes, two waves and a join | 6 of 6 complete in three waves (3, 2, 1); peak concurrency 2 at width 2 | 2 | 1,222 | 242,509 | 0 | 0 | 0 | 0 |
| S5 | Failure and recovery | provider error: one retry, then failed; timeout: no retry; engine crash then `resume`: one writer; worker crash after writing: `crash_with_writes` | 12 | 5,226 | 242,509 | 4 | 4 | 0 | 1 |
| S6 | A worker writes one undeclared file | `ownership_violation`; neither the node that depends on it nor an independent node is dispatched, in the first `drive` or a second one. A control run of the same DAG without the extra file completes with no judgment | 5 | 3,077 | 242,509 | 2 | 2 | 0 | 0 |
| S7 | UI change | ship-ready refuses: `missing_risk_evidence` (`parity-measurements`); with a parity artifact supplied that reason clears | 4 | 1,430 | 250,103 | 0 | 0 | 0 | 0 |

Column meanings: **Commands** are the engine and gate commands the orchestrator runs.
**Bytes read** is the output of those commands. **Reference bytes** is the spine plus the
references a full run of that shape loads (from `load.json`; S3 adds the security reference, S7
the parity reference). **Judgments** are the distinct judgments raised. **Owner interventions**
are the judgments still open when a run stops. **Proof runs** are executions of RED specs and
of proof commands. **Retries** are the engine's automatic retries.

### Observations

- S3 and S7 also report `review_not_accepted` and `missing_local_proof`, in every call,
  because the bench records no review and runs no proof command; the one proof run in S3 is its
  RED spec. The risk-evidence reason is the one each scenario is about, and each shows it
  clear once its condition is met.
- In S5 the engine names the two failures `provider error (exit 1)` and
  `timeout (never retried automatically)`.
- A worker crash after writing and an ownership violation each raise `node_failed` beside their
  own code, so each counts as two judgments.
- S7 sets the `ui` label in `config.riskLabels`. The engine accepts it there
  (`engine-dag.mjs`, the `config.riskLabels` check) but not on a node, whose labels are limited
  to the high-risk list in `harness.mjs`. This comes from the code, not from a scenario result.
- In S6, which the bench runs at width 1, one extra file stops the whole run: the node fails,
  and a node that does not depend on it stays `pending` as well. This is the behaviour Wave 3's
  envelope item would change.

## Comparing a later wave

Run the two commands again on the later branch and compare `runs.without_units.bytes` and each
scenario's `reference_bytes`, `orchestrator_commands`, `judgments` and `owner_interventions`
with the files here. A change that lets a refusal in S3 or S7 pass is a regression, whatever it
saves. S6 may change only through an envelope the owner approved in the plan (Wave 3); outside
such an envelope the extra file must still stop the run.
