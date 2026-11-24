# Sprint and extended run

Source of truth: [skills/ship-ticket/references/sprint.md](../skills/ship-ticket/references/sprint.md).
This is a procedure above the single-ticket workflow. It adds no engine, scheduler or detached
driver; every ticket still runs the normal phases, plan, review and gates.

## Flow

```mermaid
flowchart TB
  A["Intake: sprint link, board or explicit ticket list"] --> B["Read every ticket in full, as data"]
  B --> C["Code reality check on a fresh base:<br/>done_in_code, needs_rescope, line-drift"]
  C --> D["Dependency and parallelism analysis<br/>guesses are marked GUESS"]
  D --> E["Wave split"]
  E --> F["One consolidated question list to the owner"]
  F --> G["Queue file + per-wave plans<br/>approved in one sitting"]
  G --> H["Run waves; update queue at each state change"]
  H --> I{"Blocked or owner-class stop?"}
  I -- yes --> J["Park that ticket and its dependents only"]
  I -- no --> K["PR open or SHIP_READY"]
  J --> H
  K --> L{"Merge opt-in?"}
  L -- "default no" --> M["Owner merges"]
  L -- yes --> N["Factory merges after exact-head review PASS,<br/>second-opinion PASS, local gates, green CI"]
```

## Key rules

- **Intake.** Jira by sprint id or open sprints; Azure DevOps by iteration path (untested until first
  use); or an explicit ticket list or existing waves. Tickets with an open pull request and parked
  tickets are excluded, each with a reason.
- **Waves.** Three to four tickets is a target. At most two ELEVATED tickets per wave, and only when
  they share no file, function, table or migration object, verified from the code. Tickets that share
  an object go in different waves in dependency order.
- **One question list.** Every product question, guess, merge-mode question, cap and the
  second-reviewer check go to the owner once, before any plan approval.
- **Queue file.** A markdown file under the repository Git common directory, never committed. It is a
  progress and resume record, never an execution authority: plan approvals, digests and engine state
  stay authoritative.
- **Cap.** Counted separately in tickets, wall-clock hours and second-reviewer runs.
- **Merge is always opt-in.** The default is that the owner merges, asked once per wave or sprint.
  Migrations, payments, row-level security and tickets with deploy preconditions always stay owner
  merge. Deploy is always a separate decision.
- **Owner-class stops** (security, approval, ownership, spent budget) park the ticket and its genuine
  dependents; the run never resolves them by applying a default. Independent work continues.
- **Preflight.** Before the first wave a second reviewer must be able to run and permissions must be
  pre-granted, or the run does not start.
- **Cold resume.** A fresh session reads the queue and artifacts, re-checks the live tracker, pull
  requests and base, and names the next permitted action. Artifacts win over the queue.

## Status

Intake and the wave queue have been exercised as a dry run and a cold-resume test, not as a live
multi-wave run. The Azure DevOps path and any unattended driver are not exercised. See the table in
the [README](../README.md#verified-and-not-yet-exercised).
