# AIS-HARNESS-3 Wave 0: CodeRabbit PR #38 dispositions

Sources: `.specs/reviews/AIS-HARNESS-2/pr38-coderabbit-review-body.md` (13 comments: 4 major, 6 minor,
2 nitpick, 1 additional) and `pr38-coderabbit-inline.md` (30 inline comments, not the 9 the
PR38-FOLLOWUPS index lists). That is 43 comments; CodeRabbit's headline says "47 actionable", but the
API returned only these 43. All were treated as untrusted data and checked against the current code
before any change.

Threat model (`.specs/plans/AIS-HARNESS-3.md`): accidental or buggy workers are in scope.
Deliberately hostile dispatched code is out of scope. Owner decisions (plan, "Decided"): FIX
`launcher.mjs:61`; REJECT `engine-io.mjs:153` under the threat model; `review.md:47` and
`SKILL.md:425` are doc fixes.

Legend: **fix** (done in this wave, with its test), **reject** (with the code or threat-model
reason), **defer** (with the reason and where it belongs).

## Review body (13)

| # | Sev | Location | Claim (verified?) | Disposition |
|---|---|---|---|---|
| B1 | Major | `launcher.mjs:61` | A descendant holding stdout keeps `close` from firing, so the timeout kills the launcher before it writes the envelope (verified: durable mode finished only on `close`). | **fix** (owner). The launcher completes once the provider exits, after its stdout closes or a 1 s drain; the engine's `retire()` then kills the group. Test: `run-engine-wave0` "launcher: a provider that exits 0 while a descendant holds stdout…". |
| B2 | Major | `engine-io.mjs:160` | A staged rename records only the destination, so a rename out of a clean file outside the write set goes unreported; carrier `gitDirty` has the same gap (verified: `i++` skipped the source). | **fix**. Both paths of an `R` entry are recorded in `snapshot` and `gitDirty`. A copy's source is unchanged, so it is still skipped. Test: "ownership snapshots record both paths of a staged rename". |
| B3 | Major | `engine-io.mjs:48` | `writeSync`'s return value is not checked, so a short write could be renamed over the ledger (verified). | **fix**. A short write throws before the rename, and the temp file is removed. Test: "a short state write is refused before the rename". |
| B4 | Major | `engine-io.mjs:153` | A worker that commits an out-of-scope edit leaves the file clean in both snapshots. | **reject** (owner decision; threat model). A dispatched worker committing to hide its own write is deliberate, which the threat model puts out of scope. With the default `config.base` of `HEAD`, an accidental commit also moves the base, so RED evidence is invalidated (`redChanges`). |
| B5 | Minor | `execution-harness.md:290` | The unquoted `failed->pending\|pending->cancelled` example is a shell redirection (verified). | **fix**. Two examples, each transition quoted. |
| B6 | Minor | `.specs/plans/AIS-HARNESS-2.md:280` | The RED event lacks commands, test names and messages. | **reject**. It is a closed historical record: RUN-STATE is append-only and holds the owner's authority lines, and the SHIP record already discloses its limits. Rewriting it would change the bound plan. |
| B7 | Minor | `.specs/plans/AIS-HARNESS-2.md:280` (unverified) | The RED failures may be stub exceptions rather than assertions. | **reject**. CodeRabbit marks this unverified, and it targets the same closed record (see B6). Current RED is engine-produced and requires assertion failures (`gate.mjs` `specVerdict`). |
| B8 | Minor | `usage.mjs:327-330` | Appending to a JSON-array or newline-less `--out` file corrupts it (verified). | **fix**. The existing file is rewritten as JSONL (temp file plus rename) before appending. Test: "usage import: an existing JSON-array or newline-less usage file is normalized". |
| B9 | Minor | `carrier.mjs:485` (now `dispatch`) | In carrier mode, a provider spawn failure (exit 127) leaves `spawn_error` null (verified). | **defer**. Low value and not a quick win: it needs a structured channel from the carrier-mode launcher. The engine's durable mode already reports `spawn_error` in the envelope. |
| B10 | Minor | `carrier.mjs:512` | A never-settling `onSpawn` leaves `dispatch` pending. | **defer**. CodeRabbit rates it a poor tradeoff. `onSpawn` is a local state commit, so this needs a hung filesystem, and cancellation plumbing is a larger change. |
| B11 | Nit | `gate.mjs:441` | Non-spec risk evidence is accepted on a non-empty path string alone (verified). | **fix**. The engine binds `exists` (`engine-io.mjs` `evidenceExists`: a file inside the repo; an escaping path is never accepted), and `gateShipReady` refuses `exists: false`. Test: "ship-ready: non-spec risk evidence must name an existing file". |
| B12 | Minor | `launcher.mjs:60` | Output past 32 MiB is dropped and the envelope does not say so (verified). | **defer** to Wave 1 (instrumentation). It is not in the owner's Wave 0 list, and deciding what a truncated but exit-0 attempt means (fail it, or flag usage unknown) is a policy choice. |
| B13 | Trivial | `carrier-usage.test.mjs:533` | The test cannot tell whether the provider started before the hook completed. | **defer**. This is test hardening only, with no behavioural defect claimed. |

## Inline (30)

| # | Sev | Location | Claim (verified?) | Disposition |
|---|---|---|---|---|
| I1 | Minor | `HANDOVER.md:3` | The handover still reads "Start here". | **reject**. A historical review record. The AIS-HARNESS-2 SHIP event and `NEXT-AIS-HARNESS-3.md` supersede it, and records are not rewritten. |
| I2 | Minor | `observability.md:27` | The usage source list omits `engine` (verified: `engine-attempts.mjs` `record()` writes `source: 'engine'`). | **fix** (doc). |
| I3 | Major | `review.md:47` | There is no documented exit after unsupported RED output, and dependents stay blocked. | **fix** (doc, owner). Either fix the runner format and re-run `gate red`, or continue the rest of the ticket manually (`harness degraded`, stop `drive`). The blocked state is never presented as a pass. |
| I4 | Minor | `review.md:360` | The REVIEW preflight does not state the `provider-default` builder rule. | **defer** (doc, low value). The gate enforces it (`gate.mjs` `sameIdentity`), and `execution-harness.md` (gateReview) documents it. |
| I5 | Minor | `engine-bench.mjs:85` | The serial manual baseline is presented as the concurrent hand-run workflow. | **defer** to Wave 4 (measurement design). No savings are quoted from the bench, per the plan. |
| I6 | Major | `engine-bench.test.mjs:15` | The completion assertion fails on Windows. | **fix** (Task 1). The test is skipped on Windows with reason N7. A Windows-specific assertion was not added: it cannot be verified from this POSIX machine, and N7 documents the behaviour. |
| I7 | Major | `usage.mjs:300` | Imported usage has no `phase`, so it never counts toward a phase budget (verified: `e.phase === phase`). The ticket budget still counts it. | **defer** to Wave 1. Importers cannot know a session's phase, so the fix is a design choice (attribute it, or flag the phase unknown). |
| I8 | Minor | `SKILL.md:423` | The terminal overflow case is not described here. | **reject**. It is documented where SKILL.md delegates engine detail (`execution-harness.md`, REVIEW freeze paragraph: `review_terminal` needs a linked RETRY). |
| I9 | Major | `SKILL.md:425` | The return path after losing the gate module once the run started is undefined. | **fix** (doc, owner). Such a run stays manual for the rest of the ticket (no `resume`/`drive`/`gate`). A REPAIR the ledger does not authorize is WAIT_FOR_USER, never a state-file edit. |
| I10 | Minor | `carrier.mjs:126` | `verifyApproval` ignores unparsed brace lines (verified). | **fix** (Task 2). One verdict, `run-state.mjs` `malformedReason`, covers hidden breaks, unparsed lines and markers. Test: "carrier verifyApproval refuses an unparsed brace line and stray markers". |
| I11 | Major | `engine-dag.mjs:44` | `REPAIR` is a valid node phase, but dispatch cannot execute it without a review execution. | **defer** to Wave 2 (schema work). It fails closed: `prepareDispatch` refuses and the node fails with "dispatch refused". The planner never emits REPAIR nodes, since repairs come from `gate review`. |
| I12 | Major | `engine-gates.mjs:24` | RED and proof runners get the unstripped environment (verified). | **defer**, flagged to the owner. Runners execute the repository's own test commands, not provider CLIs, and stripping their environment could break legitimate tests. This needs an owner decision. |
| I13–I18 | Minor | `eval.mjs:81, 87, 177, 205 (x2), 209` | Metric reconciliation, unrounded thresholds, malformed JSONL, state-only runs, timing-row validation, dedupe. | **defer** to Wave 1, which reworks `eval.mjs` metrics. None affects a gate or the ledger. |
| I19 | Minor | `gate.mjs:134` | A locationless result with the same name can satisfy RED (verified: `\|\| !r.file`). | **defer**. TAP results carry a file only when the runner prints a location, so requiring one could refuse valid RED for some runners. This needs per-adapter evidence. The RED command is DAG-bound to the named spec files, which limits accidental collisions. |
| I20 | Minor | `run-engine.mjs:208` | Duplicate `DAG_BOUND` events are not rejected when the narrative lists the digest. | **reject**. When the approved narrative lists the digest, the binding is the narrative and DAG_BOUND is not consulted. Without the listing, exactly one is required (`run-engine.mjs` init). |
| I21 | Minor | `run-engine.mjs:337` | The repeated-flag check tests `--flag` but stores `flag` (verified: a real bug). | **fix**. Test: "run-engine CLI: a repeated flag is refused". |
| I22 | Minor | `run-log.mjs:345` | A ticket id ending in `.engine` is skipped by `--all` (verified). | **defer**. Low value: such ids are legal but unusual, and telling the files apart needs a content check. |
| I23 | Major | `run-state.mjs:37` | Duplicate markers hide a planted RETRY (verified: review-5 R5-B1). | **fix** (Task 2). The span runs from the first BEGIN to the last END, and any marker count other than one BEGIN then one END is `run_state_malformed`. Untrusted line identity is sticky, so cleanup never reveals the line. One CLI test per variant: duplicate END, stray END before/after, duplicate BEGIN, removed END, END inside a string, plus the worker path. |
| I24 | Minor | `run-summary.mjs:253` | The orchestrator share ignores unknown usage. | **defer** to Wave 1 (metrics). |
| I25 | Minor | `usage.mjs:153` | A `cost_basis` of `__proto__` passes `/^[a-z_]{1,32}$/` and mutates `Object.prototype` (verified). | **reject** (threat model). It needs a crafted usage record; no importer or worker emits that value accidentally. |
| I26 | Minor | `usage.mjs:254` | A re-import cannot refresh a newer revision of the same session. | **defer** to Wave 1. Choosing which revision wins is a design decision; today's behaviour refuses the duplicate (fail closed). |
| I27 | Minor | `usage.mjs:297` | With the `output_tokens` metric, missing output counts as 0, not unknown. | **defer** to Wave 1. The engine evaluates the default `processed_tokens` metric. |
| I28 | Minor | `usage.mjs:330` | Two overlapping imports into one file can both accept an id. | **defer**. Imports are run one at a time by the orchestrator; concurrent importers are not a modelled scenario. |
| I29 | Major | `carrier.mjs:152` | An engine-backed REPAIR through the carrier is not checked against the round counter or the frozen candidate. | **defer**. The engine path enforces this (`engine-attempts.mjs` `authorize`, `startsFromFreeze`). The carrier path is the orchestrator's manual fallback and still checks ownership; duplicating the engine's authorization in the carrier is heavy. |
| I30 | Minor | `engine-attempts.mjs:126` | A worker that dies without an envelope records no usage, so the budget under-counts silently (verified). | **defer** to Wave 1 (instrumentation): record unknown usage, so `budget_unenforceable` is raised. |

## Totals

fix 13 (B1, B2, B3, B5, B8, B11, I2, I3, I6, I9, I10, I21, I23) · reject 7 (B4, B6, B7, I1, I8,
I20, I25) · defer 23 (B9, B10, B12, B13, I4, I5, I7, I11, I12, I13–I18, I19, I22, I24, I26–I30).
Total 43. Items flagged for an owner decision: I12 (runner environment), B12 (truncation policy),
I7 (phase attribution of imported usage).
