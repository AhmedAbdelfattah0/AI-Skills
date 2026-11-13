# Execution harness internals (on demand)

Mechanism and rationale moved out of [execution-harness.md](execution-harness.md), the operator card. Everything the orchestrator must or must not do stays in the card; open this file when a rule there points here or when a run misbehaves.

## Scheduling and admission

Memory probes behind `memoryBudgetMb: "auto"` (the `memory_safety` meaning is in the card):

- `memoryBudgetMb: "auto"` takes OS free memory, capped by Node's cgroup-aware
  `availableMemory()` (Node >= 22). On older Node it is capped by the cgroup
  limit minus measured cgroup usage (`memory.current` / `memory.usage_in_bytes`).
  A reserve of 1 GiB or 15% of total, whichever is larger, is subtracted. If a
  cgroup limit exists but its usage is unreadable, the estimate is
  `memory_verified: false`. Node's available/constrained probes are cgroup-aware only on Linux, so they
  are consulted only there. On macOS, `os.freemem()` counts only free pages
  (about 0.7 GB of 24 GB on the host where this was found), so the harness reads
  `vm_stat` and counts free, inactive, speculative and purgeable pages instead.

## Writer carrier

Carrier mechanism that the card summarizes in "What it enforces":

Phase bullet, continued:

When the run engine's state file exists, that
  execution must be an accepted FAIL with a finding-bound write set in its review
  chain; only without engine state does the run log's REVIEW `start` row decide.

Approval evidence bullet, continued:

Plan
  content drift remains SHIP's approved-plan digest check, because the digest
  algorithm belongs to PLAN.

Billing bullet, continued:

Variable names are matched
  case-insensitively (Windows).

Gemini and Antigravity details (the card keeps the template-only and `acknowledgeUnverifiedAuth` rules):

They get no model injection (`model_applied: false`), no usage
parsing, and `subscription_auth: "unverified"`. Antigravity has no documented
headless agent CLI that this harness relies on.

- **Verified adapters:** Claude and Codex arguments are built from flags checked
  against Claude Code 2.1.318 and Codex CLI 0.166.0:
  `claude -p --output-format json --no-session-persistence --permission-mode <acceptEdits|auto|dontAsk|manual> [--model <id>]`
  and `codex exec --json --ephemeral -s <read-only|workspace-write> [-m <id>] -`. Caller `args` are rejected, so `--model` cannot be smuggled in. `--model`/`-m`
  is emitted only when `modelMap` maps the routed tier; otherwise the provider
  default runs (`model: "provider-default"`). Hooks are not disabled (no `--bare`), so
  PostToolUse guards such as nn-guard still run.

- **Prompts** go on stdin, never on argv (process listings, Windows length limits).

- **Process control:** the prompt is read and every check passes before
  anything is spawned. An already-aborted signal never starts a worker. The worker
  leads its own process group. On POSIX, the group is terminated on **every**
  exit path (normal exit, timeout, cancellation via SIGINT/SIGTERM or an
  AbortSignal), so background descendants are reaped: SIGTERM, then SIGKILL after
  5 s. Both steps are awaited, and the result reports `process_tree_terminated`
  (a group that survives SIGKILL fails the node). Inherited pipes cannot hold
  dispatch open. On
  Windows, `taskkill /T /F` covers timeout and cancellation while the leader
  lives. Descendants that outlive a normally exiting leader are not reachable
  there.
  The carrier captures up to 32 MiB of stdout; beyond that, usage is reported as unavailable.

- **Attempt envelope:** `deps.onSpawn({attempt_id, pid, pgid})` runs after spawn
  and before the worker is released; if it throws, the worker never runs. The
  engine uses it to persist `{pid, pgid}`; a completion envelope with the
  `attempt_id` is written when the run ends.

- **Windows:** `.cmd`/`.bat` shims are resolved through `PATH`×`PATHEXT` and run
  with a quoted shell only when every argument is a safe token.

## Provider-reported usage

Counter sources and the import details behind the card's usage summary:

`counter_events.<counter>` says how many of `events`
reported that counter, so a total backed by fewer events than `events` is partial.

- Claude `--output-format json` gives `input_tokens`, `output_tokens`,
  `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens` and
  `reported_cost_usd`, plus its `cost_basis`. Under a subscription the basis is
  `list`: a list-price estimate, **not a charge**.
- Codex `exec --json` sums `turn.completed.usage` over all turns. Codex reports no
  cost, so cost stays `null`.
- Every usage record carries `source` (`carrier|engine|session|codex`),
  `source_execution_id` and `role` (`builder|repair|evidence|orchestrator|reviewer|unattributed`).
  Carrier events (or, for engine-run workers, the engine's own `source: "engine"`
  record) are the only source for worker processes (one aggregate per
  `attempt_id`); session import covers only the host session and its in-process
  subagents; Codex relay usage is its own source. Importing an execution already
  present from any source is refused (the aggregate wins), except a later reading of the same
  execution from the same source with strictly larger counters (a session imported mid-stream and
  again later): it replaces the earlier record (`replaced`), so the budget never keeps the lower count.
- Totals are partitioned by `cost_basis`; different bases are never summed
  (`totalsByBasis`).
- Missing counters stay `null` and are never zero. `cache_hit_ratio` (cache reads
  ÷ all prompt tokens) is the measured token-optimization signal.

`import-session` reads the main session and its `subagents/*.jsonl`, keeps the
last revision per message id, and assigns `role` to the main file and `--subagent-role`
(default `unattributed`, never a guessed `reviewer`) to subagent files. `import-codex` records `usage_status: "unknown"` with null
counters when the relay reports no usage; nothing is invented. `--phase`
(`PLAN|BUILD|PROVE|REVIEW|REPAIR|SHIP`) tags every imported record with that phase; without it
the record carries no phase: it is **phase unknown**, counted against the ticket budget only (never
against a phase budget), summed in `status.budget.phase_unknown` (`{records, tokens}`, present when
any exists) and in the `eval` report's `tokens_by_phase` under `phase unknown`. Records that carry a
phase keep their phase-budget semantics unchanged.

## Run engine

Files paragraph, continued:

Workers, RED
runners and proof runners all start through the one launcher in `scripts/launcher.mjs`,
the same one `carrier.mjs` uses.

### State ledger format

**State** (`ship-ticket-engine-state-v1`): `nodes` (state `pending|running|done|
failed|cancelled|stale`, `attempts`, `retries`, fingerprints), `attempts`, `repairs`,
`rounds`, `judgments`, `gates` (`red`), `freeze`, `review_chain`, `risk_labels`,
`local_proof`, `locks` (durable resource holders), `builders` (`{provider, model,
node, identity: "<provider>:<model>"}` from every real dispatch), `usage`,
`telemetry_degraded`, `events[]` (sequenced; includes `RESUME`, `INFRA_RETRY`,
`ADMISSION_REFUSED`, `RED_INVALIDATED`; with units also `UNIT_CHECKED`, `UNIT_INVALIDATED`,
`UNIT_CHECK_RETRY`, `UNIT_CHECK_DROPPED`, `UNIT_RECHECK`, `UNIT_CLEARED`; with unit reviews also `UNIT_REVIEWED`,
`UNIT_REVIEW_CYCLE`, `UNIT_REVIEW_RETRY`, `UNIT_REPAIR_ENQUEUED`, `UNIT_REPAIR_RECORDED`,
`UNIT_REPAIR_BOUND`, `UNIT_REPAIR_UNBOUND`, `UNIT_REPAIR_CANCELLED`, `UNIT_CEILING_RELEASED`) and an outbox for the run-log and RUN-STATE
sinks.

### Lock and persistence

Lock and persistence paragraph, continued:

`drive` keeps it until every launched attempt has
settled, even when one attempt fails. State is written to a temp
file, `fsync`ed, renamed, then the directory is `fsync`ed (Windows retries
`EPERM`/`EBUSY` a bounded number of times). The state commit comes first; the
run-log and RUN-STATE appends follow, keyed by event id, so a replay never
duplicates an event.

### Launch handshake and quiescence

**Launch handshake and quiescence.** Intent `{attempt_id, node,
pre_snapshot_digest}` is committed; a launcher is spawned in its own process
group and blocks on a release byte; `{pid, pgid}` is committed; only then is the
byte sent. If the engine dies first the launcher's stdin closes and the worker
never runs. Once the provider exits the completion envelope is written atomically (after its
stdout closes, or after a 1 s drain when a descendant still holds stdout open, so a lingering
descendant cannot hold the attempt until its timeout). An attempt is
recorded only after its **whole process group** is gone: surviving descendants are
killed and awaited first; quiescence that cannot be proven (always on Windows) is
`quiescence_unknown` and the node is not done. `resume` and `drive` reconcile each
attempt, RED and proof runners included: envelope present → recorded; any process in the group
alive → wait or refuse (never a second writer); group gone with no envelope →
compare with the pre-snapshot: no relevant writes → re-queue, writes → judgment
point. Quiescence means the whole group is gone (POSIX `kill(-pgid, 0)` returns
`ESRCH`). One function, `engine-quiesce.mjs` `retire()`, is the only way any attempt
(worker, RED runner or proof runner) reaches a terminal status or releases its locks, on
every path (exit, timeout, crash, exception, reconcile): it kills and awaits the group, or
accepts an attempt that never recorded a pid (never released); otherwise the attempt stays
`unknown` with its locks, and reconcile reports it live (no dispatch, so a node marked
`failed->pending` never runs beside it) until `retire()` proves its group gone. A group is
signalled only while its recorded leader is gone or still has the start time recorded at launch
(`leader_start`); a leader pid that is alive with another start time was reused by an unrelated
process, so it is never signalled and the attempt stays `unknown`.

### Authority lines

Ownership paragraph, continued:

Every RUN-STATE reader, engine and carrier, goes through `run-state.mjs`,
which splits lines on every break a common reader honours (Python `str.splitlines`: lone CR,
U+2028, U+2029, NEL, VT, FF, FS/GS/RS).

Authority lines are read
from the first BEGIN to the **last** END (to the end of the file without one), so a line planted
beside a stray marker is classified, as untrusted, and stays untrusted once the marker is cleaned
up.

Lines first seen in a block whose already-observed bytes were
rewritten are untrusted, so no later rewrite can turn hidden bytes into owner authority.

Declared `resources` are held as
durable locks per attempt; a node whose resource is held, including by a RED runner
that survived a crashed gate, is not dispatched.

`archive` paragraph, continued:

Files are staged and published whole, so a failed copy leaves no numbered
directory. `archive` copies only state, log and usage. After it runs, copy
`<git-dir>/ai-skills/ship-ticket/<ticket>.attempts` to
`<git-common-dir>/ai-skills/ship-ticket/archive/<ticket>/<run-id>-<n>.attempts`, a sibling
of the archive directory it printed.

### Base pin and SHIP_READY cross-check

`base-drift.mjs check --repo <R> --base <SHA> --target <ref> --dag <dag.json>
[--contract-paths <file>]` exits 1 and lists changed files that overlap DAG
`reads`/`writes` or the contract list (exit 3 is a git or input failure, 2 a usage error).
`ship-ready-check.mjs check --run-state <plan> --engine-log <file>... [--run-id <ID>]`
matches on the pair (`run_id`, candidate); a SHIP_READY without `run_id` is unmatched, and
`--run-id` restricts the check to that run. It fails for any SHIP_READY without a `GATE ship-ready ok` line of the
same candidate. There is no hand-written exception: editing the plan narrative changes
the approved-plan digest. When the engine cannot write the pair, record `harness degraded`
([execution-harness.md](execution-harness.md)) and get explicit user approval
(`WAIT_FOR_USER`) before the commit.

### `mark`

`mark` paragraph, continued:

The MARK event records them as
`cleared_judgments` (`[{code, node}]`), with the reason as the authorization.

## Gate internals

`scripts/gate.mjs` is a library of decisions; a refusal is returned as `{ok,
code, reasons}`, never thrown. Gate state is authoritative in the engine state
file; timing logs stay best effort and never block.

`gateRed` bullet, continued:

A spec matches a result by name and file; a result without a
  file counts only when no other result has that name and, if it failed, no other failure carries
  a location (so another file's same-named failure never makes RED).

## Eval report

Eval report section, continued:

Metrics: tokens
by role and by phase (`phase unknown` for records without one) and the orchestrator share, wall clock per phase, review and repair
rounds, pre-ship findings by severity (from `gate review` records), resume
attempts and outcomes, infra retries, admission refusals and `truncated_outputs` when an attempt's output passed
the capture cap.

The thresholds compare the unrounded
values (the printed metrics are rounded).

`--all` also finds a run through its
`<TICKET>.state.json` when its timing log is missing; a timing row without `metrics` is skipped;
the same `source_execution_id` in several `--usage` files counts once (the record with the most
tokens); a usage line that is not JSON is skipped and counted in `skipped_usage_lines` (with a
warning on stderr; the exit code is unchanged). `run-log.mjs` refuses a ticket id ending in
`.engine` (its timing log would be that ticket's engine event file).

## Audit record (`config.auditRecord`)

Opt-in boolean in the DAG config; absent or false changes nothing. Old records stay valid, and a new run may set it to true in the plan's DAG config (no default change). When true:

- An original review record also keeps `primary_outcome`, `second_opinion_outcome`, `second_opinion_identity` and `reconciliation`; on an original `outcome` is the primary's (equal to `primary_outcome`). A confirmation's `outcome` is the reconciled one (FAIL unless both reviewers PASS) and it keeps `primary_outcome`.
- GATE lines and events gain `reasons`, `unit`, `review_execution` and the submitted outcomes.
- Events get `at` and terminal attempts `ended_at`: the time the snapshot was prepared, not when the decision was made. `ctx.now` is in-process only. A write that fails before its rename persists no stamps; one that fails after it (directory sync) leaves the stamped snapshot installed.
- Binding-drift and lock refusals are not recorded.
- Reasons and `reconciliation` are untrusted diagnostic text, never authority; log rows with the switch on escape U+0085, U+2028 and U+2029 like RUN-STATE lines. The `outcome_inconsistent` refusal for a primary PASS with a finding disposed `fix` is unchanged.
