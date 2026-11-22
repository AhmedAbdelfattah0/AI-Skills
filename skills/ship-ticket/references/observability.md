# Workflow observability — phase, activity, and wait timing

Load at workflow start. Timing is operational telemetry, not ticket evidence and
not part of the reviewed candidate.

## Storage and privacy

Use `scripts/run-log.mjs` from the installed `ship-ticket` folder. It resolves the
target repository's shared Git directory (`git rev-parse --git-common-dir`) and appends to:

```text
<git-common-dir>/ai-skills/ship-ticket/<TICKET>.jsonl
```

There is one file per ticket for the whole repository: the main checkout and every
linked worktree write the same file, so a run whose phases are logged from two
worktrees is not split. `--repo` may be any directory inside the work tree. This
location survives branch switches, does not dirty the worktree, and remains
available while waiting for approval, CI, or tracker operations. It is local and
is not pushed.

**Old per-worktree logs (before S5).** Earlier versions wrote to
`git rev-parse --git-path ai-skills/ship-ticket`, which in a linked worktree is
`<git-common-dir>/worktrees/<name>/ai-skills/ship-ticket`. Those files are read,
never written, moved, copied or deleted. `start`, `end` and `event` read the common log
together with this worktree's own old log, so a start recorded there can still be ended
(the end lands in the common log) and a duplicate is still refused. `summary` and
`eval.mjs report` also read sibling worktrees' old logs, for reporting only. The carrier's
REPAIR check reads the common log and this worktree's own old log, never a sibling's.
`quarantine` changes the common log only. Engine files (`.state.json`, `.engine.jsonl`,
`.usage.jsonl`, `.attempts`) are not run logs and stay per worktree. A version before S5
reading the common log sees an end whose start is in an old per-worktree log as an
unpaired end; that is the only cross-version effect. Never put source text, prompts, ticket descriptions, credentials,
URLs with tokens, reviewer prose, or command output in the log. Metrics are only
short booleans, numbers, or enum-like labels.

The run engine ([execution-harness.md](execution-harness.md)) writes its own
events (`MARK`, resume and retry events) to a sibling file,
`git rev-parse --git-path ai-skills/ship-ticket/<TICKET>.engine.jsonl` (per worktree). It is not a timing
log: `run-log.mjs summary --all` skips it, and `run-log.mjs` never appends to it.

Measurement events (`run-log.mjs event`, `close`) are validated against a closed schema
(`scripts/measure/events.mjs`) and written by the same single append path as `start`/`end`.
Every write takes `<TICKET>.jsonl.lock` (waiting up to 10 s) and refuses unless the whole
resulting log is valid. Bytes after the last newline (an interrupted write) are moved
verbatim to `<TICKET>.jsonl.lost-<offset>-<sha>[-<layout>].json` (the layout hash keeps two recoveries with equal bytes and first offset apart), and a `log_loss` record takes their
place, so the loss stays visible. A complete but invalid line is never dropped: every write
refuses until `run-log.mjs quarantine --repo <path> --ticket <key>` moves undecodable,
malformed and invalid measurement lines to such a sidecar (with a `log_loss` record).
Damaged legacy rows are not quarantined; they refuse writes as before.

Usage events (`usage.mjs`, carrier `usageLog`, the run engine) carry `source` (`carrier`,
`engine`, `session` or `codex`; one source per execution, never double-counted) and `role`
(`builder`, `repair`, `evidence`, `orchestrator`, `reviewer`, `unattributed`: an import given no role). Per-role totals and
the orchestrator share come from `eval.mjs report`.

### Resource and cost metrics (`eval.mjs report`)

Read-only; each prints `unknown` where its source lacks data, never 0, and none is a gate.

- `peak_rss_mb` (max over attempts) and `peak_cpu_pct`: the durable launcher samples its
  process group with `ps` (first sample at 0.1 s, then every 1 s; `ps` runs with `LC_ALL=C` so
  %cpu parses under any locale) and writes the peak to the attempt envelope (`peak_rss_mb`,
  `peak_cpu_pct`, `resource_samples`). The launcher and the `ps` itself are excluded. They cover
  WORKER attempts only: the RED and proof runner processes are not launched through the
  launcher, so their peaks are not recorded. Limits: sampled peaks, so a spike between ticks is
  missed and a worker shorter than 0.1 s has no sample; RSS double-counts shared pages;
  `peak_cpu_pct` sums `ps` %cpu, a per-process average whose window differs by OS (Linux: average
  over the process lifetime; macOS: decaying recent average), so it is an estimate and not
  comparable across OSes; the group is the launcher's, so a descendant that left it is not
  counted. Windows (no process groups), a missing `ps` or a disabled sampler
  (`SHIP_TICKET_SAMPLER_OFF=1`) give `unknown`.
- `parallel_efficiency`: sum of engine attempt durations (attempt start to envelope end) /
  (wall x `config.width`), wall being first attempt start to last attempt end. 1 means every
  slot was busy; overlap is not causal time saved. Needs the run's engine state.
- `terminal_review_outcomes`: original reviews recorded with `overflow` (a terminal FAIL).
  `retries_authorized`: RETRY authorizations consumed by a new original review. Both come from
  the engine state's review chain; `unknown` without it.
- `cost_per_accepted_ticket`: reported cost of a complete run, kept per `cost_basis` (bases are
  never added; subscription estimates are not charges). `unknown` for an incomplete run or one
  with no reported cost. `cross_run` keeps the per-basis averages.
- `tokens_by_phase`: processed tokens per usage phase; records without a phase (imports without
  `--phase`) are the `phase unknown` bucket, counted against the ticket budget only.
- `attempt_timing`: per engine attempt `wall_ms`, `api_ms` (provider-reported API time, from the engine
  state's usage record with the attempt id, or a `--usage` record) and `other_ms = wall - api_ms`. Worker
  attempts of claude carry `api_ms`; review executions do not (session and codex imports carry none), so
  review `api_ms` is `unknown`. `proof_wall_ms`: the sum over exited proof attempts of `started_at` to
  `ended_at`; `unknown` when none exists or any lacks either stamp (never a partial sum). A proof
  attempt's `ended_at` exists only with `config.auditRecord: true`, so Phase-0 plans set it.
  `unattributed_share_pct`: processed-token share of records whose role is `unattributed` (imports given
  no role).
- `truncated_outputs` (present only when any): attempts whose launcher output passed the 32 MiB
  capture cap (`{attempt_id, kind, node, stdout_bytes}`); a flag, never a changed outcome.
- `orchestrator_share_pct` is `unknown` when any usage record of the run lacks counters; a
  usage file's malformed (e.g. crash-truncated) JSONL lines are skipped, as before Wave 1.

Logging is best effort. If the helper is absent or one call fails, announce
`timing telemetry degraded`, record the reason in the execution summary when
possible, and continue the ticket. A telemetry failure never changes a workflow
outcome and never causes `WAIT_FOR_USER`.

## Start a run

Create one opaque, safe `run_id` before the first tracker or repository read. Use
the normalized ticket key/ID, not the full URL. If the target Git repository is
not known at invocation, start logging immediately after it is resolved and add
`--metric started_late=true` to the workflow start.

```bash
node <SHIP_TICKET_SKILL>/scripts/run-log.mjs start \
  --repo <TARGET_REPO> --ticket <TICKET> --run-id <RUN_ID> \
  --kind workflow --name ship_ticket --event-id workflow

node <SHIP_TICKET_SKILL>/scripts/run-log.mjs start \
  --repo <TARGET_REPO> --ticket <TICKET> --run-id <RUN_ID> \
  --kind phase --name UNDERSTAND --event-id phase-understand
```

`<SHIP_TICKET_SKILL>` means the directory containing this skill's `SKILL.md`.
Keep the same ticket and run ID for the entire execution, including later turns
that resume a legitimate wait.

### Preflight: `check`

Before `EnterPlanMode`, run the read-only preflight once:

```bash
node <SHIP_TICKET_SKILL>/scripts/run-log.mjs check --repo <TARGET_REPO> --ticket <TICKET>
```

It writes nothing (no probe file, no directory, no lock) and prints one JSON line
`{ok, resolved_dir, legacy_logs, degraded?, reason?}`. Exit 0: telemetry can be
written to `resolved_dir`. Exit 1, with `reason`: not a Git repository, the
directory (or its nearest existing parent) is not writable, the lock file is
unreadable, or the existing log would refuse writes (for example a torn tail,
`incomplete_tail`; the next write or `quarantine` moves it aside). An exit 1 is a
declared degradation of the run's telemetry: record it (`harness degraded`) and
continue. It never blocks the ticket. `degraded` lists notes that do not stop
writes: `legacy_logs_read_only` (old per-worktree logs exist and are read),
`stale_lock_recoverable` (a dead writer's lock the next write recovers).

### Several intervals at once: `batch`

A shell variable holding several `--metric` flags is one word in zsh, so the flags
never reach the parser. Put the operations in a JSON file instead (or pass `-` and
write them to stdin):

```bash
node <SHIP_TICKET_SKILL>/scripts/run-log.mjs batch \
  --repo <TARGET_REPO> --ticket <TICKET> --run-id <RUN_ID> --ops-file <ops.json>
```

`ops.json` is an array of
`{"op": "start"|"end", "kind", "name", "event_id", "outcome"?, "metrics"?: {"key": value}}`.
Metric values are typed exactly as `--metric key=value` types them and are never
word-split, so `--` and spaces survive verbatim. Every op is validated before the
first write; the ops then run in order and the first failure stops the batch. A
batch is not atomic: ops already applied stay. stdout is one JSON line,
`{"applied": n}` or `{"applied": n, "failed": {"index": i, "reason": "..."}}` (exit 1).

### Supplied timestamps (estimated)

`start --started-at <iso>` and `end --ended-at <iso>` record a boundary that was
not stamped when it happened. The value must be strict UTC ISO-8601
(`2026-01-01T00:00:00.000Z`). It is checked against the clock when the row is
written: not later than now + 5 s, not earlier than now - 24 h, and never earlier
than any row already recorded for the run (so a supplied value never backdates
recorded history, and an end is never before its start). A refused value writes
nothing. The row carries `timestamp_source: "supplied"` and `label: "estimated"`;
`duration_ms` is computed from the recorded pair. A row stamped by the clock is
unchanged and has neither key; when a supplied value up to 5 s ahead is already
recorded, the clock stamp is raised to it so the run's rows stay in time order.
`event --started-at/--ended-at` take the same now + 5 s / now - 24 h bounds. They
are not held to the time-order rule, because measurement events can overlap
earlier rows (concurrent review lanes), and they carry their own `label`.

### What the log can and cannot claim

- The log is local, unauthenticated and unsigned. Any process that can write
  `.git` can forge, edit or delete events.
- Supplied timestamps are self-asserted. They are bounded, not verified.
- The `run-log integrity` line of `ship-ready-check.mjs` (with `--repo` and
  `--ticket`) claims only what was parsed, counted and paired: events, runs, open
  phases, warnings and `log_loss` records. It does not claim the log is complete or
  authentic. A deleted or missing log prints `unavailable`, never zero events.
- Telemetry never gates a ship decision. The integrity line never changes
  `ship-ready-check`'s exit code, and a failed `check` is a recorded degradation.

## Close intervals

End an interval with the exact same `kind`, `name`, and `event-id`:

```bash
node <SHIP_TICKET_SKILL>/scripts/run-log.mjs end \
  --repo <TARGET_REPO> --ticket <TICKET> --run-id <RUN_ID> \
  --kind phase --name UNDERSTAND --event-id phase-understand \
  --outcome pass
```

End a phase before starting the next phase. On `COMPLETE` or `FAIL`, end the
current phase and the workflow. Use workflow outcome `complete` or `fail` so the
summary can classify the run.

The phase duration is wall-clock time and includes nested activities and waits.
Kind totals therefore overlap and must not be added together. Repeated phases
are summed, not replaced by their first occurrence. A missing measurement is
unknown, not zero. Raw records remain `ship-ticket-run-log-v1`; the changed
summary contract is `ship-ticket-run-summary-v2`. Existing logs are never rewritten.

## What to time

Always time the six phases. Also time these activities when they occur because
they explain most variance:

| Phase | Activity name |
|---|---|
| UNDERSTAND | `tracker_fetch`, `repository_recon`, `review_preflight` |
| PLAN | `native_plan_mode` (its end metrics carry provider/consumer contract outcomes) |
| BUILD | `contract_materialization`, `frontend_build`, `backend_build`, `integration_join`, `unit_review`, `unit_review_repair`, `unit_review_confirmation` |
| PROVE | `frontend_proof`, `backend_proof`, `shared_proof`, `runtime_attacks`, `ui_evidence` |
| REVIEW | `frontend_review`, `backend_review`, `contract_review`, `primary_review`, `optional_review`, `review_reconcile`, `review_repair`, `review_confirmation` |
| SHIP | `commit_push_pr`, `ci_wait`, `tracker_completion` |

The `unit_review*` activities in the BUILD row occur only with `config.unitReview`; their metrics are in [units.md](units.md), Timing activities.

Use a unique event ID for every occurrence, for example
`prove-repository-checks-1`. Do not create an interval for every shell command or
status message; the extra bookkeeping would distort the workflow being measured.

Give activities that were actually dispatched together the same
`--metric parallel_group=<stable-id>`. Allocate that ID per dispatch wave and
never reuse it within a run; when a later ready set is dispatched, create a new
ID even if it performs the same kind of work. Use one high-level interval per
worker or proof/review partition, not one per command. Explicit wave IDs are
authoritative: keep sequential or single-member waves visible with limitations,
rather than silently splitting or dropping them. Summaries measure concurrent
wall overlap and peak concurrency, not causal time savings. Frontend/backend
overlap uses the union of all intervals on each side. Per-wave
`concurrent_wall_overlap_ms` counts wall time with at least two members active,
not summed worker time. `frontend_overlap_pct` and `backend_overlap_pct` use
their respective side's union as denominator; `frontend_backend_union_overlap_pct`
uses the combined union. Thus 100% of the shorter side is not 100% of BUILD.
Check `timing_basis`, `carrier_timed_members` and `flags` before comparing waves.

Writer nodes dispatched through the harness carrier return `run_log_metrics`
(`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`,
`reasoning_tokens`, `reported_cost_usd`). Import them on that activity's end event with
`run-log.mjs end … --metrics-from <carrier-result.json>`, where `<carrier-result.json>` is
the carrier's **stdout** JSON saved to disk (`carrier.mjs run dispatch.json > carrier-result.json`),
not its `resultFile`, which holds only the final message. That reads the pairs directly, so
no shell has to word-split a metrics string (zsh does not). They are provider-reported counters only. An absent counter is unknown
and is not recorded as zero. A Claude subscription cost is a list-price estimate,
not a charge. Use the harness `parallel_group` (run-ID prefixed) as the wave ID.

### Execution identity and timing provenance

Before each authorized REVIEW execution, allocate `review_execution=review-<opaque>`
and attach it to its phase, reviewer, repair and confirmation events. The prefix
prevents numeric metric coercion. Record candidate ID, host/counterpart, skill
revision or content hash, configured primary/recovery/optional/confirmation
ceilings and whether deadlines are enforced. A user-authorized retry keeps the
workflow run ID but gets a new execution ID and predecessor; generating an ID
never authorizes a retry. Legacy unlabelled events remain unknown execution scope.

Use metrics `candidate_id`, `host_agent`, `counterpart_agent`, `skill_revision`,
`primary_ceiling_ms`, `recovery_ceiling_ms`, `optional_ceiling_ms`,
`confirmation_ceiling_ms`, `deadline_enforcement=enforced|advisory`, and
`previous_review_execution` on a retry. Put execution metadata on its REVIEW
phase start; put the ID and current candidate on each activity. Confirmation
binds the repaired candidate, not the initial candidate; never change identity
inside an already-started activity.

Review timing calls, per round: `start` the REVIEW phase with `candidate_id` and
`review_execution`, plus `skill_revision` and the four `*_ceiling_ms`. Then `start` each
of `primary_review` (or its partition reviews), `optional_review` (also when degraded
or unavailable), `review_reconcile`, and `review_repair` / `review_confirmation` when run,
with `candidate_id` and `review_execution`; `end` each when it actually ends. Missing
identity metrics, an invalid `gap_reason` or an oversized value refuse a start; a refusal writes nothing. A missing or invalid
`skill_revision` or ceiling never refuses: it is recorded as `unknown` and reported
`unknown`; do not retry or wait on it, because the REVIEW phase start row is what
authorizes a REPAIR. Time covered by no interval: end the phase with
`--metric gap_reason=no_start_stamp|wait|host_sleep|unknown` (a start refuses any other value). On an `end`, an invalid, over-long (over 512 characters), multi-line or repeated `gap_reason` or `skill_revision` is recorded as `unknown` with a stderr note naming the rejected value, so such a value cannot leave the interval open; the identity metrics (`candidate_id`, `review_execution`) stay strict, and an end is still refused for other malformed input (an unknown interval, a bad `--metric` form). `summary` reports
`missing_review_intervals` (a count; `unknown` without execution IDs; `at_least` with a
known sum when some runs are unknown).

Logger timestamps describe when records were appended. They must not be backdated
to make delayed result collection look like prompt completion. When the detected
carrier/version provides trustworthy start/finish timestamps, retain those
separately with their source and collection delay. A blocking-return timestamp is
valid only when completion was actually observed then; later batch collection is
not a blocking return. Manual estimates remain approximate. Never import relay
prompts, output text, stderr or credentials into telemetry.

For a supported `delegate-relay.result.v1` result, bind a fresh absolute result
path **before** dispatch (its file must not exist), and give the relay its parent
directory as `--out-dir`:

```bash
node <SHIP_TICKET_SKILL>/scripts/run-log.mjs start \
  --repo <TARGET_REPO> --ticket <TICKET> --run-id <RUN_ID> \
  --kind activity --name primary_review --event-id primary-review-1 \
  --metric candidate_id=<CANDIDATE_ID> --metric review_execution=review-<OPAQUE_ID> \
  --carrier-result <FRESH_ABSOLUTE_RESULT_JSON>
```

After collecting the result, end that same event with the registered
`--carrier-result` path and the orchestrator's assessed `--outcome`. Process
completion alone is not a passing review. The helper verifies repository,
read-only mode and dispatch binding, then imports only whitelisted timing/status
metadata plus a result digest into `carrier_timing`: `started_at`, `ended_at`,
`duration_ms`, `collection_delay_ms`, `source=relay_result`, `tool` and `status`.
Candidate/execution identity comes from the registered dispatch. The result path
and contents are not exposed in the summary. Repeating the identical import is
idempotent; do not add `--metric` on that repeated end call.

Unsupported or invalid result imports degrade telemetry, not ticket execution:
close the event normally without `--carrier-result` and report the missing
carrier measurement. Legacy/missing carrier timing uses logger intervals, which
may include deferred collection. Native Plan Mode's no-write boundary below
overrides result registration/import just as it overrides ordinary logging.

### Native Plan Mode and logging

Native Plan Mode permits read-only shell commands and must not be bypassed to
write telemetry. This exception overrides every generic start/end/wait instruction.
If Plan Mode was already active at invocation, do not start logger intervals or
exit merely to log. Keep timestamps in session context, declare telemetry delayed,
and after approval resume logging with `started_late=true`; never invent earlier
logger events. When an interactive Codex mode switch requires the user, record a
`wait` named `plan_mode_switch` while writes are still permitted. If it cannot be
closed after switching because Plan Mode forbids writes, defer closing until the
host permits logging and mark `includes_native_plan_mode=true`; do not interpret
that interval as pure user wait. Keep actual switch/debate timestamps in context.
Immediately before an available native entry transition, start the PLAN phase and a
`native_plan_mode` activity with `--metric write_suspended=true`. Do not invoke
the logger again while Plan Mode is active. Immediately after human approval
and exit from Plan Mode (Claude: approved `ExitPlanMode`; Codex: approved
implementation handoff and host mode change), end existing activity/phase intervals
with `--metric approval=approved`, then continue directly into the
after-approval work. Also record `frontend_contract=accepted` and
`backend_contract=accepted` for full-stack work. Do not open another approval
wait.

That activity's wall time intentionally includes research, cross-model debate and the
human approval wait because the read-only boundary prevents trustworthy nested
writes. While it is open, the summary reports `planning_or_approval`, not
`open_without_wait`. If Plan Mode is unavailable, log PLAN activities and the
ordinary approval wait normally. Time each `plan_debate_exchange` with its own
ID and `round=<n>` when writes are allowed. In native Plan Mode, keep exchange
start/end timestamps in the permitted plan draft or session context and persist
those in section 7 after approval; do not backdate logger events. The final PLAN
metrics carry total measured debate time without conflating it with user wait.

Useful end metrics are:

- REVIEW phase, per execution: `review_profile=standard|elevated`, `finding_count=<n>`,
  `repair_batches=0|1`, `confirmation_count=0|1`;
- PLAN phase (or `native_plan_mode` end): `host_agent=claude|codex|other|unknown`,
  `counterpart_agent=claude|codex|fable|other|unavailable`, `debate_responses=0|1|2|3`,
  `debate_calls=<n>` (includes failed attempts),
  `debate_status=converged|unresolved|degraded`, `debate_elapsed_ms=<n>`;
- `primary_review`: `finding_count=<n>`;
- `optional_review` (the mandatory second opinion; the activity name is historical): `counterpart_agent=codex|fable|other|unavailable`, outcome `pass`, `findings`, or `degraded` and metric
  `reason=timeout|unavailable|no_concurrency|tool_error`;
- PROVE phase: `repair_batches=0|1|2`;
- CI wait: `poll_count=<n>`.

Example:

```bash
node <SHIP_TICKET_SKILL>/scripts/run-log.mjs end \
  --repo <TARGET_REPO> --ticket <TICKET> --run-id <RUN_ID> \
  --kind phase --name REVIEW --event-id phase-review --outcome pass \
  --metric review_profile=standard --metric finding_count=0 \
  --metric repair_batches=0 --metric confirmation_count=0
```

## Legitimate pauses versus accidental stops

Immediately before yielding in `WAIT_FOR_USER`, start a `wait` interval with a
specific name such as `plan_approval`, `scope_decision`, `credentials`, or
`external_authority`. Do not close the phase or workflow.

```bash
node <SHIP_TICKET_SKILL>/scripts/run-log.mjs start \
  --repo <TARGET_REPO> --ticket <TICKET> --run-id <RUN_ID> \
  --kind wait --name plan_approval --event-id wait-plan-approval-1
```

On the first action after resuming, end that wait with outcome `resumed`, then
continue the still-open phase. An open phase with an open wait is an intentional
pause. An old open phase without a wait is a diagnostic lead, not proof of an
agent stop: the logger may have failed or records may be missing.

If a previous session's run ID is not in context, recover it with `summary` and
resume the latest open run for that ticket. Do not invent a second run merely
because the conversation crossed turns.

## Analyze one ticket or the experiment

```bash
node <SHIP_TICKET_SKILL>/scripts/run-log.mjs summary \
  --repo <TARGET_REPO> --ticket <TICKET>

node <SHIP_TICKET_SKILL>/scripts/run-log.mjs summary \
  --repo <TARGET_REPO> --all
```

The v2 JSON summary exposes `counters.repair_batches` and `counters.confirmations`
as `{observed, declared, declaration_complete, mismatch}`. Observed zero means no
matching activity record, not proven absence of repairs. Missing declarations
are `null`; disagreement remains explicit rather than silently choosing a count.
`review_executions` partitions these counters by recorded IDs; apply limits per
execution, not to the run-wide sum. Legacy logs cannot prove that multiple
confirmations belonged to one execution. Both primary and optional degradations
remain visible as observed counts. Check which runs have measurements before
comparing medians; older runs without provenance are not a controlled baseline.

Wall durations and REVIEW-to-BUILD ratios remain available separately from
`build_wall_excluding_recorded_waits_ms` and
`review_wall_excluding_recorded_waits_ms`: union and clip waits to the measured interval
before subtracting them. This is not active compute time, and incomplete wait
logging limits its meaning. `phase_coverage[].uninstrumented_ms` is time without
covering activity or wait evidence, not idle time. Overlapping activity totals are
not elapsed time. `durations.build_ms` and `durations.review_ms` sum all completed
occurrences, including authorized retries rather than hiding them behind the first.

Malformed, truncated or unsupported records produce integrity warnings while
valid records remain readable. Affected runs have unknown integrity-dependent
state, not a diagnosed unexpected stop. Writers refuse unsafe appends to damaged
history, including an incomplete tail; leave the file untouched and report
telemetry degradation rather than repairing history automatically. A missing end
record cannot establish whether a reviewer ran too long or was collected late.

One real ticket is a smoke test. Use three to five representative tickets before
judging the redesign. The redesign is working when:

- the primary workflow stays within its 12-minute ceiling plus at most three
  minutes for result recovery; confirmation has its separate six-minute ceiling.
  The full REVIEW phase also includes reconciliation, repair and legitimate waits,
  so its wall time is not the primary reviewer's deadline;
- REVIEW-to-BUILD time falls materially from the old workflow and does not grow
  across repeated review cycles;
- every completed run has zero open intervals;
- every intentional cross-turn pause has an open `wait` while paused;
- review repair batches never exceed one and confirmation never exceeds one per
  authorized execution, with no contradictory observed/declared counters;
- full-stack BUILD shows one group containing both `frontend_build` and
  `backend_build`, with non-zero overlap unless concurrency was declared degraded;
- optional reviewer timeouts appear as degradations, not stalled workflows.

Investigate an old open phase with no open wait against transcript/carrier
evidence before calling it a continuation defect. For the next full-stack trial,
check provenance, enforced deadlines, complete counters and real timing sources
first; do not rerun shipped tickets merely to fill missing telemetry.

## Legacy-path telemetry notes (ASTF-42 S-04a1)

- `eval` `attempt_timing[].models_used` (sorted) appears only when a usage record joined to the attempt names a model; absent means unknown. `usage.mjs` records carry the same optional string array.
- `eval` `review_round_wall_ms.excluded_unknown` also counts rounds with an unfinished interval or an open REVIEW phase: their truncated wall still prints on the round but never enters the percentiles.
- Stamps with a non-Z offset (for example `+02:00`) are normalised to UTC in `intervals` and `open_intervals`; Z stamps are untouched.
- The legacy figures of logs without offsets, models or unfinished rounds are guarded by `legacy-figures.golden.json`, captured from origin/main by `legacy-golden.mjs` (maintainer only; it archives the pinned base commit, never the working tree).

Deferred to S-04a2 (relay `exit`/`usage` import, removed from S-04a1 after two failed confirmations of the same defect class): the event
contract must define a CLOSED set of known usage keys with an explicit unknown-key rule, and settle these surviving defects. Inherited
property names (`constructor`, `__proto__`, `toString`) must not index the key table. A cap on kept unknown counters must report the
omitted count rather than drop silently. Claude's nested `output_tokens_details.thinking_tokens` needs a mapping or an explicit
"not imported". `exit` and `usage` must be validated when a log row is read (`validCarrierTiming`). Nested numerics (for example `output_tokens_details`) need an explicit decision too. Both relays' real result shapes
need fixtures (the Codex relay writes no `usage` today). Until then carrier timing imports only the whitelisted timing/status fields.

Known limit of the END leniency (S-04a1): an invalid or repeated `gap_reason` or `skill_revision` on an `end` is recorded as `unknown` and, because
start and end metrics merge with the end winning, it overwrites a valid value declared at the start of the same interval. The stderr note
names the rejected value; omitting the key instead is a candidate refinement for S-04a2.
