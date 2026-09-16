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
Kind totals therefore overlap and must not be added together.

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
`--metric parallel_group=<stable-id>`. Use one high-level interval per worker or
proof/review partition, not one per command. The summary derives group wall time,
summed worker time, estimated saved time, peak concurrency and frontend/backend
overlap from their timestamps.

### Native Plan Mode and logging

Native Plan Mode permits read-only shell commands and must not be bypassed to
write telemetry. Immediately before `EnterPlanMode`, start the PLAN phase and a
`native_plan_mode` activity with `--metric write_suspended=true`. Do not invoke
the logger again while Plan Mode is active. Immediately after approved
`ExitPlanMode` returns, end that activity and the PLAN phase as the first two
actions, with `--metric approval=approved`, then continue directly into the
after-approval work. Also record `frontend_contract=accepted` and
`backend_contract=accepted` for full-stack work. Do not open another approval
wait.

That activity's wall time intentionally includes research, Codex critique and the
human approval wait because the read-only boundary prevents trustworthy nested
writes. While it is open, the summary reports `planning_or_approval`, not
`open_without_wait`. If Plan Mode is unavailable, log PLAN activities and the
ordinary approval wait normally.

Useful end metrics are:

- REVIEW phase: `review_profile=standard|elevated`, `finding_count=<n>`,
  `repair_batches=0|1`, `confirmation_count=0|1`;
- `primary_review`: `finding_count=<n>`;
- `optional_review`: outcome `pass`, `findings`, or `degraded` and metric
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
pause. An old open phase with no open wait is evidence that the agent stopped
without entering a terminal state.

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

The JSON summary reports phase/activity/wait durations, open intervals and their
age, `planning_runs`, `waiting_runs`, `open_without_wait`, repair and confirmation
counts, optional-review degradations, review medians, and the median
REVIEW-to-BUILD ratio. It also reports parallel groups, peak concurrency,
estimated parallel savings and median frontend/backend overlap. An
`active_or_unexpected_stop` is expected during live work; if its age keeps growing
after the agent turn ended, it is a continuation failure.

One real ticket is a smoke test. Use three to five representative tickets before
judging the redesign. The redesign is working when:

- completed standard reviews normally finish within the 15-minute primary
  ceiling and elevated reviews within their bounded primary-plus-optional window;
- REVIEW-to-BUILD time falls materially from the old workflow and does not grow
  across repeated review cycles;
- every completed run has zero open intervals;
- every intentional cross-turn pause has an open `wait` while paused;
- review repair batches never exceed one and confirmation never exceeds one;
- full-stack BUILD shows one group containing both `frontend_build` and
  `backend_build`, with non-zero overlap unless concurrency was declared degraded;
- optional reviewer timeouts appear as degradations, not stalled workflows.

Treat a run with an old open phase and no open wait as a continuation defect.
Inspect its last completed interval to locate where the agent reported and then
failed to execute the next action.
