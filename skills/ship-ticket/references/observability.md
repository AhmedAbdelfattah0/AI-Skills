# Workflow observability — phase, activity, and wait timing

Load at workflow start. Timing is operational telemetry, not ticket evidence and
not part of the reviewed candidate.

## Storage and privacy

Use `scripts/run-log.mjs` from the installed `ship-ticket` folder. It resolves the
target repository's Git metadata directory and appends to:

```text
<git-metadata>/ai-skills/ship-ticket/<TICKET>.jsonl
```

This location survives branch switches, does not dirty the worktree, and remains
available while waiting for approval, CI, or tracker operations. It is local and
is not pushed. Never put source text, prompts, ticket descriptions, credentials,
URLs with tokens, reviewer prose, or command output in the log. Metrics are only
short booleans, numbers, or enum-like labels.

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
| BUILD | `contract_materialization`, `frontend_build`, `backend_build`, `integration_join` |
| PROVE | `frontend_proof`, `backend_proof`, `shared_proof`, `runtime_attacks`, `ui_evidence` |
| REVIEW | `frontend_review`, `backend_review`, `contract_review`, `primary_review`, `optional_review`, `review_repair`, `review_confirmation` |
| SHIP | `commit_push_pr`, `ci_wait`, `tracker_completion` |

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
  `counterpart_agent=claude|codex|other|unavailable`, `debate_responses=0|1|2|3`,
  `debate_calls=<n>` (includes failed attempts),
  `debate_status=converged|unresolved|degraded`, `debate_elapsed_ms=<n>`;
- `primary_review`: `finding_count=<n>`;
- `optional_review`: `counterpart_agent=claude|codex|other|unavailable`, outcome `pass`, `findings`, or `degraded` and metric
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
