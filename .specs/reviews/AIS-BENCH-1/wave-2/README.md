# AIS-BENCH-1 Wave 2 — results (GitHub issue #54)

Recorded on 2026-11-11 from the Wave 2 branch (base `main` at `2c5dbd7`). Compare with
`../baseline/README.md`. Figures are script output, not edited by hand:

| File | Produced by |
|---|---|
| `load.json` | `node skills/ship-ticket/scripts/load-record.mjs --json` |
| `scenarios.json` | `node skills/ship-ticket/scripts/engine-bench.mjs --scenario all --json` |
| `sentence-result.json` | `node .specs/reviews/AIS-BENCH-1/wave-2/sentence-check.mjs --base 2c5dbd7 --allowlist .specs/reviews/AIS-BENCH-1/wave-2/allowlist.json --new-file skills/ship-ticket/references/brief.md --json sentence-result.json` |

## What the orchestrator loads

| Measure | Baseline | Wave 2 | Target |
|---|---|---|---|
| Full run, no unit fields (workflow start to SHIP) | 242,509 | 207,496 | at most 220,000 |
| Full run, a DAG node with `unit` (adds `units.md`) | 242,509 | 237,503 | — |
| Every condition (UI, security, elevated, Codex, units, on-demand internals) | 266,053 | 273,479 | — |
| BUILD (operator card plus `brief.md`) | 67,942 | 44,634 | at most 58,000 |
| `execution-harness.md` (operator card) | 67,942 | 40,914 | planned at most 38,000; raised after review (below) |
| `review.md` | 32,656 | 22,526 | at most 22,700 |
| `plan.md` | 26,847 | 25,171 | at most 25,400 |
| Unit text in the no-unit load set | 25,359 | 0 | none (the `plan.md` split-or-not guidance is the named exception) |

The spine (`SKILL.md`) grew by 273 bytes (42,072 to 42,345) for the new load-table rows and
pointers. The every-condition total is higher than the baseline because it also counts the
on-demand `harness-internals.md` (12,432) and `brief.md`, which the baseline did not have.
Per-phase figures are in `load.json`.

## Scenarios

`scenarios.json` equals `../baseline/scenarios.json` in every field except `wall_ms` and
`reference_bytes`. S3 and S7 still refuse, S6 still stops the run. The fake-provider limits in
the baseline README apply here too.

| # | Reference bytes, baseline | Wave 2 |
|---|---|---|
| S1, S2, S4, S5, S6 | 242,509 | 207,496 |
| S3 | 255,066 | 220,053 |
| S7 | 250,103 | 215,090 |

## Nothing lost

`sentence-result.json`: 1,834 comparison units in the old files, 1,933 in the new. 33 old units
are not found as such in the new set, 127 new units are not in the old, 5 are duplicated; every
one is covered by an entry in `allowlist.json` (131 entries, each with a reason) or belongs to
the wholly new `brief.md`. The reviewer reads every entry. Entries fall into five kinds:
a sentence split without any word changed, a re-pointed link, a position word ("above" and
"below"), a unit clause moved to `units.md`, and a new pointer or lead-in sentence.
Mentions of unit-only identifiers outside `units.md` are listed under `unit_identifier_hits`.

## Limits

- The sentence check compares normalised units, so it proves no sentence vanished; it does not
  prove a moved sentence is still in the right place. That is what the card test in the plan
  (would an orchestrator that never opens the other file act differently?) and the review are for.
- The first card was 37,990 bytes, under the planned 38,000, but it had moved seven blocks whose
  sentences decide what the orchestrator does (unknown usage is not "within budget", lock recovery,
  round counters, a rebind after a crash, RED runner reconciliation, Docker ownership errors, the
  billing refusal), and two more (remote CI is still checked; a repair of a risk-labelled node gets
  the strong tier) were found in the retry review. Reviewers flagged them; they were restored to the card verbatim. The
  card is therefore 40,914 bytes, which is the measured size, not the planned cap. The 38,000
  figure was a plan estimate that the plan itself said a veto would raise.
- An allowlist entry that matches nothing fails the check, so a covered sentence that later
  changes or disappears cannot hide behind its old entry.
