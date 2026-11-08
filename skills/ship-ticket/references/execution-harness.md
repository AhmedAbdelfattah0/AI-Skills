# Execution harness (BUILD, PROVE, SHIP; never PLAN)

Bundled dependency-free Node helpers (Node >= 18) under `ship-ticket/scripts/`,
distributed by the existing installer with the skill. They make the existing
dependency-driven orchestration measurable and enforce its safety rules at the
process boundary. They do not replace the DAG, approval, reviewer independence
or security gates in `SKILL.md`.

**PLAN is protected.** The phase-aware helpers (`harness.mjs` scheduling and
routing, `carrier.mjs`) refuse PLAN. `usage.mjs summary` and `docker-lifecycle.mjs`
take no phase and do not check one, so the rule for them is procedural: do not
call them during PLAN. None of them selects a PLAN model, schedules PLAN work,
shortens the debate or touches approval. Do not run
them inside native Plan Mode. REVIEW keeps its own read-only relay
([review.md](review.md)); the carrier refuses REVIEW.

**Unavailable is not refused.** If a helper is *unavailable* (no Node, missing
file, a provider with no adapter), report `harness degraded: <reason>` and
continue under the ordinary `SKILL.md` rules, which keep the same approval and
ownership controls. A *safety refusal* blocks and is never bypassed by falling
back:

| Refusal | Outcome |
|---|---|
| approval evidence missing or mismatched | return to approval; do not dispatch |
| subscription auth not proven, unverified auth not acknowledged | **WAIT_FOR_USER**: the user decides billing |
| unresolved `strong` model | **WAIT_FOR_USER** for a `modelMap.strong`, or run the node on the host itself |
| `ownership_check: "violated"` | failed node; bounded repair of the listed paths |
| `admit` not admitted | shrink or delay the wave |

## Lifecycle integration

| Phase | Helper use |
|---|---|
| UNDERSTAND | `harness.mjs resources` once, to record host capacity |
| PLAN | none |
| BUILD | `run-engine.mjs drive` the bound DAG (it schedules, admits and dispatches through the carrier); `gate` RED before production nodes; `docker-lifecycle.mjs labels` for any container |
| PROVE | `run-engine.mjs drive` for writer repairs; `schedule` checks with exclusive `port:`/`db:`/`docker:` locks; `docker-lifecycle.mjs reuse` before starting a service |
| REVIEW | `schedule` advice only; dispatch stays on the read-only relay (the engine never dispatches REVIEW); record its artifacts with `gate` |
| SHIP | `gate` ship-ready, then `usage.mjs summary` and `eval.mjs report`; `docker-lifecycle.mjs cleanup` dry run, then `--apply` for this run's containers |

The hand-run flow (`schedule` → `admit` → `carrier.mjs run`, gates recorded in
the plan's RUN-STATE) stays valid and is the documented fallback whenever the
engine or gate module is unavailable. It is a declared degradation, not a bypass.

Write every helper input and output outside the candidate (a scratch directory
or the repository's Git metadata); never add them to the reviewed candidate.

## Scheduling and admission

```bash
node <SHIP_TICKET_SKILL>/scripts/harness.mjs resources
node <SHIP_TICKET_SKILL>/scripts/harness.mjs schedule /abs/wave-input.json
node <SHIP_TICKET_SKILL>/scripts/harness.mjs admit /abs/admit-input.json   # exit 3 = not admitted
```

`schedule` input:

```json
{
  "phase": "BUILD",
  "groupPrefix": "<RUN_ID>",
  "maxConcurrency": 3,
  "memoryBudgetMb": "auto",
  "nodes": [
    { "id": "frontend", "deps": [], "reads": ["contracts"], "writes": ["apps/web"],
      "resources": ["cache:frontend-build"], "estimatedMemoryMb": 2500, "complexity": "medium" },
    { "id": "backend", "deps": [], "reads": ["contracts"], "writes": ["apps/api"],
      "resources": ["db:integration"], "estimatedMemoryMb": 3500, "complexity": "high", "risk": ["auth"] },
    { "id": "integration", "deps": ["frontend", "backend"], "reads": ["apps/web", "apps/api"],
      "writes": ["tests/integration"], "resources": ["db:integration"], "estimatedMemoryMb": 1500 }
  ]
}
```

- Paths are repository-relative. Writer/writer and writer/reader overlaps
  (including ancestor/descendant) serialize. Named exclusive locks (`port:`,
  `db:`, `cache:`, `docker:`, `fixture:`, `generator:`, `lock:`) serialize.
  An undeclared lock cannot be detected.
- `groupPrefix` (the run ID) plus a fresh per-call `schedule_id` makes every
  `parallel_group` unique, across phases and across repeated scheduling in one
  phase, as `SKILL.md` requires. Pass the wave's `parallel_group` to `run-log.mjs`.
  Without a prefix the output says `group_ids_unique: false`.
- `memoryBudgetMb: "auto"` takes OS free memory, capped by Node's cgroup-aware
  `availableMemory()` (Node >= 22). On older Node it is capped by the cgroup
  limit minus measured cgroup usage (`memory.current` / `memory.usage_in_bytes`).
  A reserve of 1 GiB or 15% of total, whichever is larger, is subtracted. If a
  cgroup limit exists but its usage is unreadable, the estimate is
  `memory_verified: false`. `memory_safety` is `estimated` only when a verified
  budget applied and **every** node has `estimatedMemoryMb`; otherwise it is
  `unverified`.
  Node's available/constrained probes are cgroup-aware only on Linux, so they
  are consulted only there. On macOS, `os.freemem()` counts only free pages
  (about 0.7 GB of 24 GB on the host where this was found), so the harness reads
  `vm_stat` and counts free, inactive, speculative and purgeable pages instead.
- `admit` input `{ "phase", "estimatedMemoryMb", "members" }` re-reads live
  memory immediately before a wave starts. A refusal shrinks or delays that wave,
  never the plan. Neither command reserves memory.
- Default `maxConcurrency` is `min(3, cpu_count)`.

### Model tiers

Tiers are `economy`, `balanced`, `strong` and `inherit`. They are labels the host
maps to real model IDs, not model IDs themselves.

- REVIEW, any high-risk node (`security`, `auth`, `tenancy`, `payments`,
  `migration`, `schema`, `shared-contract`, `concurrency`) and `complexity: "high"`
  are always `strong`. A requested cheaper tier cannot override that. `concurrency`
  covers state machines, optimistic concurrency/CAS, request ordering and
  client-side async state with races. `risk` is a closed
  vocabulary: these eight labels are the only accepted values, and any other
  label is refused rather than silently routed as low risk. Map a ticket's own
  risk wording onto them; a node with no applicable label carries `risk: []`.
- `complexity: "low"` or an explicit `model` request gets that tier.
- Everything else is `inherit`. On the carrier, `strong` requires
  `modelMap.strong` on a verified adapter, or dispatch is refused: an unknown
  provider default never satisfies a strong requirement. `inherit` applies
  `modelMap.inherit` (pass the host's own model ID). Without it the CLI's
  configured default runs, which may differ from the host's model, and the
  result says `model_resolution: "provider-default"`. Report that as a degradation.

## Writer carrier

```bash
node <SHIP_TICKET_SKILL>/scripts/carrier.mjs inspect /abs/dispatch.json   # validate + verify approval, no process
node <SHIP_TICKET_SKILL>/scripts/carrier.mjs run /abs/dispatch.json       # exit 2 = node failed
```

```json
{
  "phase": "BUILD", "provider": "claude", "nodeId": "frontend",
  "workdir": "/abs/worktree", "repoRoot": "/abs/worktree",
  "approval": { "ticket": "<TICKET>", "runId": "<RUN_ID>", "approvedPlanDigest": "<DIGEST>" },
  "ownership": { "writes": ["apps/web"], "othersOwned": ["apps/api"] },
  "promptFile": "/abs/scratch/frontend.prompt.md",
  "complexity": "medium", "risk": [], "modelMap": { "strong": "<model-id>", "economy": "<model-id>" },
  "timeoutMs": 1800000,
  "resultFile": "/abs/scratch/frontend.message.json",
  "usageLog": "/abs/scratch/usage.jsonl"
}
```

What it enforces:

- **Phase:** BUILD, PROVE, SHIP and REPAIR only; PLAN and REVIEW are refused.
  `REPAIR` (a review repair writer) routes like BUILD, is recorded as
  `phase: "REPAIR"` in results and usage, and requires `reviewExecution` (the
  review round being repaired). When the run engine's state file exists, that
  execution must be an accepted FAIL with a finding-bound write set in its review
  chain; only without engine state does the run log's REVIEW `start` row decide. It may declare `redSpecs` (repo-relative spec
  paths); then `redEvidence` must be an absolute path to a non-empty file with
  the failing-run output, written by the orchestrator, or dispatch is refused.
- **Plan roots are orchestrator-owned.** A change under `.specs`/`.spec` during a
  run is RUN-STATE bookkeeping: it is reported in `orchestrator_paths_changed`
  and is not a `writes_outside_ownership` violation.
- **Approval evidence (event binding, not content verification):**
  `.specs/plans/<TICKET>.md` (or `.spec/plans/`) must hold a RUN-STATE `START`
  event for `runId` whose `approved_plan_digest` equals the supplied digest. Plan
  content drift remains SHIP's approved-plan digest check, because the digest
  algorithm belongs to PLAN. The carrier reads the plan artifact and never writes
  it, and it refuses any `ownership.writes` covering `.specs`/`.spec`, so a worker
  cannot forge `START`. The same applies to `ownership.othersOwned`, so a plan
  change can never be exempted.
- **Billing:** `billing` defaults to `subscription`. The child environment
  drops the provider's API-routing variables (Claude: `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, Bedrock/Vertex/Foundry switches.
  Codex: `OPENAI_API_KEY`, `CODEX_API_KEY`, `OPENAI_BASE_URL`. Gemini/Antigravity:
  Google API-key and Vertex variables). The CLI's own status is then checked in
  that environment: `claude auth status --json` must report
  `authMethod: "claude.ai"` with `apiProvider: "firstParty"`, and
  `codex login status` must report `Logged in using ChatGPT`. Any other answer
  refuses dispatch before a process starts. Variable names are matched
  case-insensitively (Windows). `"billing": "api"` also needs
  `"allowApiBilling": true`, which only the user can authorize.
- **Verified adapters:** Claude and Codex arguments are built from flags checked
  against Claude Code 2.1.318 and Codex CLI 0.166.0:
  `claude -p --output-format json --no-session-persistence --permission-mode <acceptEdits|auto|dontAsk|manual> [--model <id>]`
  and `codex exec --json --ephemeral -s <read-only|workspace-write> [-m <id>] -`.
  Caller `args` are rejected, so `--model` cannot be smuggled in. `--model`/`-m`
  is emitted only when `modelMap` maps the routed tier; otherwise the provider
  default runs (`model: "provider-default"`). `bypassPermissions`, `plan` and
  `danger-full-access` are refused. Hooks are not disabled (no `--bare`), so
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
- **Ownership check:** status, size, mtime, mode and content hash of every dirty
  path at the Git top level are snapshotted before and after the run. Any path
  whose state changed is a violation unless it is under `ownership.writes` or
  the declared concurrent `othersOwned`; that includes pre-existing user changes
  the worker reverted or deleted. A violation fails the node and the paths are
  listed. Outside a Git work tree the check reports `unavailable`.
  Git-ignored paths (build output, `node_modules`, local env files) are not in
  `git status` and are **not covered**: `clean` means no tracked or untracked,
  non-ignored path changed outside ownership. Keep worker outputs that matter
  out of ignored locations, or check them separately.
- **Output privacy:** stdout shows metadata only. The worker's final message goes
  to a fresh `resultFile` (mode 0600). Output paths are canonicalized through
  symlinks and must be outside the repository work tree or inside its real Git
  metadata directory. A failed result or usage write is reported in
  `telemetry_degraded` and never discards the execution outcome.
- **Structured completion:** the result carries `changed_paths` (the net change
  from the carrier's own snapshot, not the worker's word), `attempt_id` and
  `role` (`builder|repair|evidence`, default by phase). Worker prompts end with a
  fenced `ship-ticket-report` JSON block
  `{"tests":[{"cmd","result"}],"red_seen":[],"blockers":[],"needs_outside_ownership":[]}`;
  the last block is validated into the message file. A missing or invalid block
  is not fatal: the result says `report: "unstructured"` with the failure reason.
- **Attempt envelope:** `deps.onSpawn({attempt_id, pid, pgid})` runs after spawn
  and before the worker is released; if it throws, the worker never runs. The
  engine uses it to persist `{pid, pgid}`; a completion envelope with the
  `attempt_id` is written when the run ends.
- **Windows:** `.cmd`/`.bat` shims are resolved through `PATH`×`PATHEXT` and run
  with a quoted shell only when every argument is a safe token.

Gemini and Antigravity were not installed where this was built, so their flags
are unverified. They run only from an explicit trusted `executable` + `args`
template. They get no model injection (`model_applied: false`), no usage
parsing, and `subscription_auth: "unverified"`. Under subscription billing they
also need `acknowledgeUnverifiedAuth: true`, set only on the user's explicit
instruction and never inferred. They cannot satisfy a `strong` node. Antigravity has no documented
headless agent CLI that this harness relies on.

## Provider-reported usage

Each run appends one JSONL event to `usageLog`. The result's `run_log_metrics`
holds `key=value` pairs that `run-log.mjs end --metrics-from <result.json>` imports
(`<result.json>` is the carrier's stdout saved to disk, not `resultFile`)
directly (see [observability.md](observability.md)).

```bash
node <SHIP_TICKET_SKILL>/scripts/usage.mjs summary /abs/scratch/usage.jsonl --run-id <RUN_ID>
```

`--run-id` restricts the sum to one run when the log is shared; without it every
run in the file is summed. `counter_events.<counter>` says how many of `events`
reported that counter, so a total backed by fewer events than `events` is partial.

- Claude `--output-format json` gives `input_tokens`, `output_tokens`,
  `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens` and
  `reported_cost_usd`, plus its `cost_basis`. Under a subscription the basis is
  `list`: a list-price estimate, **not a charge**.
- Codex `exec --json` sums `turn.completed.usage` over all turns. Codex reports no
  cost, so cost stays `null`.
- Every usage record carries `source` (`carrier|engine|session|codex`),
  `source_execution_id` and `role` (`builder|repair|evidence|orchestrator|reviewer`).
  Carrier events (or, for engine-run workers, the engine's own `source: "engine"`
  record) are the only source for worker processes (one aggregate per
  `attempt_id`); session import covers only the host session and its in-process
  subagents; Codex relay usage is its own source. Importing an execution already
  present from any source is refused (the aggregate wins).
- Totals are partitioned by `cost_basis`; different bases are never summed
  (`totalsByBasis`).
- Missing counters stay `null` and are never zero. `cache_hit_ratio` (cache reads
  ÷ all prompt tokens) is the measured token-optimization signal.

Imports and budgets:

```bash
node <SHIP_TICKET_SKILL>/scripts/usage.mjs import-session <session.jsonl> --run-id <ID> --out <usage.jsonl> [--since iso] [--until iso] [--role orchestrator|reviewer] [--phase <PHASE>]
node <SHIP_TICKET_SKILL>/scripts/usage.mjs import-codex <relay-result.json> --run-id <ID> --out <usage.jsonl> [--phase <PHASE>]
```

`import-session` reads the main session and its `subagents/*.jsonl`, keeps the
last revision per message id, and assigns `role` to the main file and `reviewer`
to subagent files. `import-codex` records `usage_status: "unknown"` with null
counters when the relay reports no usage; nothing is invented. `--phase`
(`PLAN|BUILD|PROVE|REVIEW|REPAIR|SHIP`) tags every imported record with that phase; without it
the record carries no phase: it is **phase unknown**, counted against the ticket budget only (never
against a phase budget), summed in `status.budget.phase_unknown` (`{records, tokens}`, present when
any exists) and in the `eval` report's `tokens_by_phase` under `phase unknown`. Records that carry a
phase keep their phase-budget semantics unchanged. The budget metric
is `processed_tokens = input + output + cache_read + cache_write` (or
`output_tokens`); see Budgets above. With the run engine, import into
`git rev-parse --git-path ai-skills/ship-ticket/<TICKET>.usage.jsonl`: the engine reads
that file before every dispatch.

## Run engine

```bash
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs init   --repo <R> --ticket <T> --run-id <ID> --dag /abs/dag.json
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs status --repo <R> --ticket <T> --run-id <ID>   # the only thing the orchestrator reads
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs drive  --repo <R> --ticket <T> --run-id <ID> [--until <node>]
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs resume --repo <R> --ticket <T> --run-id <ID>
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs mark   --repo <R> --ticket <T> --run-id <ID> --node <id> --transition 'failed->pending' --reason <text>
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs mark   --repo <R> --ticket <T> --run-id <ID> --node <id> --transition 'pending->cancelled' --reason <text>
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs clear-unit --repo <R> --ticket <T> --run-id <ID> --unit <unit>   # needs an owner UNIT_CLEAR (Units)
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs gate unit-review --repo <R> --ticket <T> --run-id <ID> --input <file> [--unit <unit>]   # config.unitReview (Units)
```

The engine runs the process (dispatch, retries, staleness, resume) and leaves
judgments to the orchestrator and the user. It adds no policy: approval,
reviewer independence, billing and ownership checks are the carrier's and
`SKILL.md`'s. `drive` exits 2 on a judgment point; any other failure exits 1.

**Files**, all under `git rev-parse --git-path ai-skills/ship-ticket/` and never
committed: `<TICKET>.state.json` (the ledger), `<TICKET>.engine.jsonl` (the
engine's event file), `<TICKET>.lock`, `<TICKET>.attempts/` (per-attempt
envelopes) and `<TICKET>.usage.jsonl` (imported orchestrator/reviewer usage, read by
budgets). The timing log `<TICKET>.jsonl` stays owned by `run-log.mjs`. Workers, RED
runners and proof runners all start through the one launcher in `scripts/launcher.mjs`,
the same one `carrier.mjs` uses.

**DAG** (`ship-ticket-engine-dag-v1`, `{schema, config, nodes}`). Unknown fields
are refused, never dropped.

- `config`: `provider`, `modelMap`, `permissionMode`, `billing`, `width`,
  `memoryBudgetMb`, `timeoutMs` (clamped to 1 s..1 h for both validation and the
  timer), `budget` (`{ticket_tokens, phase_tokens}`), `candidateExclusions` (exactly
  `.specs/plans/<TICKET>.md` and `session-log.md`, or absent; anything else is
  `dag_invalid` at `init`), `testCommands` (`{<name>: {cmd, args, format?}}`; an entry
  with `format` `tap|vitest-json|jest-json` is a RED runner, and `gate ship-ready`
  runs every entry as the local proof), `base`, `riskLabels`
  (ticket-level labels from the closed risk vocabulary plus `ui`; unioned with
  node `risk` for `gate ship-ready`), `acceptanceIds`, `unitRecheckCeiling` and `unitReview` (opt-in, below). Billing is
  `subscription` unless the user authorized `allowApiBilling`.
- node: `id`, `deps`, `reads`, `writes`, `othersOwned`, `resources`, `risk`,
  `complexity`, `modelTier`, `estimatedMemoryMb`, `promptFile`,
  `phase` (`BUILD|PROVE|REPAIR|SHIP`), `role` (`builder|repair|evidence`),
  `evidence`, `redSpecs`, and the opt-in `unit`, `acceptance`, `checks` (see **Units**).

**State** (`ship-ticket-engine-state-v1`): `nodes` (state `pending|running|done|
failed|cancelled|stale`, `attempts`, `retries`, fingerprints), `attempts`, `repairs`,
`rounds`, `judgments`, `gates` (`red`), `freeze`, `review_chain`, `risk_labels`,
`local_proof`, `locks` (durable resource holders), `builders` (`{provider, model,
node, identity: "<provider>:<model>"}` from every real dispatch), `usage`,
`telemetry_degraded`, `events[]` (sequenced; includes `RESUME`, `INFRA_RETRY`,
`ADMISSION_REFUSED`, `RED_INVALIDATED`; with units also `UNIT_CHECKED`, `UNIT_INVALIDATED`,
`UNIT_CHECK_RETRY`, `UNIT_RECHECK`, `UNIT_CLEARED`; with unit reviews also `UNIT_REVIEWED`,
`UNIT_REVIEW_CYCLE`, `UNIT_REVIEW_RETRY`, `UNIT_REPAIR_ENQUEUED`, `UNIT_REPAIR_RECORDED`,
`UNIT_REPAIR_BOUND`, `UNIT_REPAIR_UNBOUND`, `UNIT_REPAIR_CANCELLED`, `UNIT_CEILING_RELEASED`) and an outbox for the run-log and RUN-STATE
sinks. `status` prints the compact `ship-ticket-engine-status-v1` view, including
`red_pending`, `budget` (`{ticket, phase, flags}` or null) and `telemetry_degraded`, and
`units` and `unit_ceiling` only when the DAG has units (`unit_checks` and `unit_ceiling` in state
likewise), `unit_reviews_pending` only with `config.unitReview` (`unit_reviews` in state likewise),
and `truncated_outputs` only when an attempt's output passed the capture cap (below).

**Approval binding.** `init` recomputes the plan narrative digest (the plan
file with the text between the RUN-STATE markers removed) and requires it to
equal `approved_plan_digest` of this run's START event. The DAG file's digest
must be listed in the approved plan or recorded by exactly one `DAG_BOUND`
RUN-STATE event of the run, written at approval time before the first dispatch.
`DAG_BOUND` is never rewritten or superseded; rebinding needs a new approved
START. Digests are written `sha256:<hex>` (the skill's form); the legacy
`sha256-<hex>` spelling is normalized. Every mutating command (`drive`, `resume`,
`mark` and every `gate`) first re-verifies that the state belongs to `--run-id`
(`run_mismatch`) and both digests (`approval_mismatch`, `dag_mismatch`); a mismatch
mutates nothing.

**Lock and persistence.** Every mutating command takes one lock file created
with `O_EXCL` holding `{pid, process_start_time, host, run_id, nonce}`, and
releases it on every exit path. `drive` keeps it until every launched attempt has
settled, even when one attempt fails. Only the same host may recover it, and only when
the PID is dead or alive with a different known start time (PID reuse); a live holder
whose start time cannot be read stays `lock_held`. A foreign-host
or malformed lock is refused with a recovery instruction, and concurrent
recovery is decided by an `O_EXCL` recovery marker. State is written to a temp
file, `fsync`ed, renamed, then the directory is `fsync`ed (Windows retries
`EPERM`/`EBUSY` a bounded number of times). The state commit comes first; the
run-log and RUN-STATE appends follow, keyed by event id, so a replay never
duplicates an event. A sink that fails (an unwritable log or plan) never fails the
command: the event stays in the outbox, `status.telemetry_degraded` names it, and the
next command or `resume` replays it.

**Launch handshake and quiescence.** Intent `{attempt_id, node,
pre_snapshot_digest}` is committed; a launcher is spawned in its own process
group and blocks on a release byte; `{pid, pgid}` is committed; only then is the
byte sent. If the engine dies first the launcher's stdin closes and the worker
never runs. Once the provider exits the completion envelope is written atomically (after its
stdout closes, or after a 1 s drain when a descendant still holds stdout open, so a lingering
descendant cannot hold the attempt until its timeout). The launcher keeps at most 32 MiB of
stdout; past it the envelope records `truncated: true` and the full `stdout_bytes` (CodeRabbit
B12, owner decision: flag, do not fail). The attempt's outcome is decided exactly as without the
flag; workers, RED, proof and unit-check runners carry it on their attempt envelope, and
`status`/`eval` list them as `truncated_outputs` (`{attempt_id, kind, node, stdout_bytes}`). An attempt is
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
process, so it is never signalled and the attempt stays `unknown`. The state
commit refuses (`unquiesced_exit`) to persist a terminal attempt that did not pass through it;
a state file written before that rule is refused at load (`legacy_state`: confirm nothing of
the run still runs, delete the state file, re-run `init`). Retries cover only spawn failures and provider errors with proven
quiescence and no relevant writes, at most 1 per node, logged. A timeout or
tree-kill alone never retries.

**Ownership.** Worker snapshots include the ticket plan file; its only allowed change
is a verified RUN-STATE append (`run-state.mjs` `runStateAppendOnly`), so a worker that
edits the narrative is an `ownership_violation`. A worker's verified append is kept
auditable as a `PLAN_APPENDED` engine event; a worker append of `START`, `DAG_BOUND`,
`RETRY` or `UNIT_CLEAR`, of a line starting with `{` that is not JSON, or of any line break other than `\n` /
`\r\n` is an ownership violation (`run-state.mjs` `workerRunStateAppend`, for engine and carrier
dispatches alike). Every RUN-STATE reader, engine and carrier, goes through `run-state.mjs`,
which splits lines on every break a common reader honours (Python `str.splitlines`: lone CR,
U+2028, U+2029, NEL, VT, FF, FS/GS/RS). A block holding one of those (other than `\r\n`), or a
`{` line that is not JSON, is `run_state_malformed`: every mutating command refuses until the
owner normalizes the plan file. So is any marker count other than exactly one BEGIN followed by
exactly one END (a duplicate or stray END, a second BEGIN, a missing END, a marker inside an
event's JSON); the carrier's `verifyApproval` refuses the same blocks. Authority lines are read
from the first BEGIN to the **last** END (to the end of the file without one), so a line planted
beside a stray marker is classified, as untrusted, and stays untrusted once the marker is cleaned
up. The refusal says how to repair the block: in a separate edit, deleting a non-JSON `{` line
rather than editing it into JSON, then re-appending any owner event as a new, distinct line once
nothing is live. Lines first seen in a block whose already-observed bytes were
rewritten are untrusted, so no later rewrite can turn hidden bytes into owner authority. `RETRY`, `UNIT_CLEAR` and `DAG_BOUND` authority stays the orchestrator's RUN-STATE write,
as without the engine, and the engine honours an authority line only from
`state.authority.trusted` (`engine-authority.mjs`). At the start and end of every locked
command it classifies each new `START`/`DAG_BOUND`/`RETRY`/`UNIT_CLEAR` line: trusted only when no attempt
(worker, RED runner or proof runner) was started since its last quiescent observation,
otherwise `untrusted` (listed in `status.authority_untrusted`). Any dispatched code (a worker,
a RED spec, a proof command) that appends one is therefore never honoured; an owner line
appended while something dispatched is live is also untrusted, and the owner re-appends a
distinct line (for example with a timestamp) once `status` shows nothing live. When git cannot produce a snapshot
the result is `ownership_unavailable`, never clean. Declared `resources` are held as
durable locks per attempt; a node whose resource is held, including by a RED runner
that survived a crashed gate, is not dispatched.

**Staleness.** A completed node stores fingerprints of its declared reads and
writes (existence, type, mode, content hash; never mtime). On `drive` or
`resume`, a changed input or output marks the node and its dependency closure
`stale`; stale nodes re-run automatically only before the REVIEW freeze.

**Units (opt-in; AIS-HARNESS-3 Wave 2a).** Absent fields change nothing: a DAG without them
produces the same state, events and output as before (pinned by the golden test in
`run-engine-units.test.mjs`); there is no schema bump. A node may carry `unit` (a safe id,
distinct from every node id and `testCommands` name), `checks` (names of `config.testCommands`
entries; needs `unit`) and `acceptance` (acceptance criterion ids). The plan template carries no
machine-readable criteria, so the ids come from `config.acceptanceIds`, which the approved plan
binds with the DAG digest. `init` refuses (`dag_invalid`) an unknown check, a check without a
unit, an acceptance id outside `config.acceptanceIds`, `acceptance` without it, and, once any node
has `acceptance`, an id of `config.acceptanceIds` mapped to no node. Units may not form a cycle,
also not through unit-less nodes.
- **Checks.** Once every node of a unit is done, the engine holds new dispatch, waits until nothing
  is live, and runs the union of the unit's `checks` under the runner protocol (attempt kind
  `unit-check`, the unit's `resources` as durable locks, `retire()` before a result counts, a
  surviving or unknowable group is `quiescence_unknown` with nothing recorded; `resume` reconciles
  it like a RED runner). Each unit is checked at most once per engine command, and `--until` does
  not limit which units are checked. A runner that cannot start is retried once (`UNIT_CHECK_RETRY`); a failing
  exit never is. The unit is `verified` only when every check exits 0 and the checks left the
  declared `reads` and `writes` of every node (unit-less upstream generators included) and the
  `config.base` commit unchanged; a check that changes any of them fails with that cause, so a
  dependent unit is never verified while a generator stays `done` on inputs its check rewrote. A unit with no `checks` is verified vacuously once its nodes are done (its evidence
  still binds, for invalidation). A node of another unit, or a unit-less node, counts a dependency as done
  only once that dependency's unit is verified. A failure before the freeze marks the unit's nodes
  `failed` (`node_failed`) and reports `unit_check_failed`: `mark failed->pending` of one node
  spends that node's retry and re-runs it, the unit's other nodes failed only by the check return
  to `done` without re-running, and the checks run again. After the freeze the nodes stay `done`
  and `unit_check_failed` goes to the owner. `gate review` and `gate ship-ready` refuse
  `units_unverified` while any unit is not verified.
- **Dead ends and the owner clearing path.** A post-freeze `unit_check_failed` and a
  `unit_invalidation_storm` are cleared only by `run-engine.mjs clear-unit --unit <u>`, which
  requires a trusted RUN-STATE authority event `{"run_id", "event": "UNIT_CLEAR", "unit",
  "predecessor": <the unit's current evidence id, status.units.<u>.evidence.id>, "authorized_by",
  "reason"}`. It follows the RETRY authority model: honoured only when the engine first observed the
  line with nothing dispatched able to run (a worker that appends one is an ownership violation; a
  line seen while something may run is untrusted, `unit_clear_unauthorized`, and the owner re-appends
  a distinct line once `status` shows nothing live). No matching event, or one linked to other
  evidence, is `unit_clear_unauthorized`; a unit not at a dead end is `unit_clear_refused` (before
  the freeze a failed unit takes `mark failed->pending`). Refusals exit 1. The clear removes that
  unit's storm judgment, resets only that unit's evidence and invalidation counter (its causes stay)
  and records why: `UNIT_CLEARED` (engine event and RUN-STATE line, with `authorized_by` and
  `reason`) and `status.units.<u>.clears`. The next drive re-checks the unit, and that re-check
  spends the parent ceiling: a clear never lifts it.
- **Parent-wide ceiling.** `config.unitRecheckCeiling` (integer 0..100, needs a unit; default 4,
  applied at use and never written into the bound config, so it is covered by the DAG digest only
  when set) caps unit re-checks per run across ALL units together: every check round of a unit that
  already completed one in this run (after a failed result and a `mark`, an invalidation, or a
  clear) spends one (`UNIT_RECHECK`, with its kind `rerun|invalidation|cleared`); a first check and
  a `UNIT_CHECK_RETRY` infra retry spend none. Neither the unit count nor the node count scales it,
  so marking each of k nodes of a unit in turn, or a second unit, gets no fresh allowance. Once it
  is spent, the next re-check raises the durable judgment `parent_ceiling` instead (no automatic
  retry; neither `mark`, `resume` nor `clear-unit` clears it: the owner decides, and continuing
  means a re-`init` under a new owner-approved START). The storm guard is evaluated first.
  `status.unit_ceiling` shows `{limit, used}`, plus `reserved` while an open unit repair holds slots.
  With unit reviews, the same allowance is also spent by every unit re-review, unit repair and unit
  confirmation (below), and held slots count as spent for every other unit's re-check.
- **Unit review (opt-in; AIS-HARNESS-3 Wave 2b-ii).** `config.unitReview: true` (boolean, needs a
  unit; never defaulted, so the DAG digest covers it only when set) makes each unit need its own
  independent review chain. The engine never dispatches a reviewer: the orchestrator relays it
  ([review.md](review.md), Unit review) and `gate unit-review` validates and records it under the
  lock, reusing `gate.mjs` `gateReview` (contract, enums, dispositions, builder roster, distinct
  reviewers). The input is `{unit, review_execution, kind: original|confirmation,
  approved_plan_digest, dag_digest, base_commit, primary, second_opinion?, reconciliation,
  graded_artifacts?, repair_ownership?, repair_prompt_file?}`, where the reviewers' `candidate_id`
  is the unit's evidence id (`status.units.<u>.evidence.id`); `--unit` may name the unit instead. It
  is accepted only when the unit is `verified`, nothing is live, the digests are the bound ones and
  the evidence id and base commit are the current evidence's. Refusals record nothing:
  `unit_review_disabled`, `unknown_unit`, `binding_mismatch`, `attempts_live`, `unit_unverified`,
  `stale_base`, `stale_evidence`, `chain_broken` (an execution id of another chain),
  `unit_review_current`, `unit_review_open`, `retry_unauthorized`, `repair_outside_unit`,
  `repair_prompt_missing`, `reviewers_same_provider`, `parent_ceiling` (not a durable judgment), and
  every `gateReview` refusal. A unit is risky when a member node carries a risk label or the ticket
  has `config.riskLabels`. Its review and its confirmation then need a second opinion
  (`missing_second_opinion`) from a provider other than the primary's (`reviewers_same_provider`;
  a CodeRabbit fallback is route `coderabbit` with identity `coderabbit:<model>`). Otherwise a
  second opinion is optional and validated when given. The record carries each reviewer's provider
  and model; model-name roles are the orchestrator's duty. The record (in `S.unit_reviews.<u>.chain`) binds the plan and DAG
  digests, the unit, the evidence id, its base commit and whole-tree candidate (`tree_candidate`),
  the reviewers, findings and outcome. The review state is recomputed at every read against the
  current evidence: `unreviewed`, `pass`, `stale` (the reviewed evidence no longer holds: a fresh
  original is due), `fail` awaiting `repair|recheck|confirmation`, or `fail` terminal (computed
  judgment `unit_review_terminal`). An accepted FAIL with findings to fix, before the freeze, enqueues
  `repair-<rx>` (kind `unit-review`) through the review-repair authorization (the FAIL record in the
  unit's chain, `rounds.unit_review_repairs`, finding-bound writes that must lie inside the unit's
  declared writes); `drive` dispatches it only while the unit's evidence is the reviewed one (else
  `UNIT_REPAIR_CANCELLED`), records it in the unit chain without freezing and re-checks the unit.
  The new evidence becomes the candidate of the one targeted confirmation only when, against the
  binding the FAIL reviewed, nothing but files inside the repair write set changed
  (`UNIT_REPAIR_BOUND`). A declared directory is compared file by file against its tree recorded
  at the FAIL, so a repair writing `src/a.txt` inside a declared `src` binds, while any other
  changed, added or removed entry inside it is outside the repair. A node re-run, a dependency unit's re-check, an upstream change or a base
  move instead marks the repair `unbound` (`UNIT_REPAIR_UNBOUND`) and the review stale. This
  bookkeeping is idempotent and runs on every `drive`, `resume`, `status` and gate, so a crash
  between a re-check and its binding is recovered. A failed confirmation, an overflow FAIL, a FAIL
  with nothing to fix, a failed repair, a FAIL whose cycle the ceiling cannot carry
  (`ceiling_refused`, recorded with `repair_opened: false`) and any FAIL after the freeze are
  terminal: only a trusted RUN-STATE `RETRY {review_execution, predecessor: <the unit's
  last execution>, authorized_by}` admits a new original. A re-review, a repair and a confirmation
  spend the parent-wide ceiling. Opening a repair needs 3 unheld slots: it spends 1 and holds its
  re-check and confirmation for the unit until the cycle ends or is cancelled
  (`UNIT_CEILING_RELEASED`). The spends are recorded
  (`UNIT_REVIEW_CYCLE` with kind `unit_rereview|unit_repair|unit_confirmation` and its trigger:
  stale evidence and its invalidation causes, the owner RETRY, the fixed findings, the repair).
  `gate review` (original and confirmation) and `gate ship-ready` refuse `unit_reviews_missing`
  until every unit has a current PASS (and `gate review` the two Wave 3 refusals below). The `drive` outcome `done` does not cover pending unit
  reviews; `status.unit_reviews_pending` is authoritative. The carrier's REPAIR authorization also
  reads the unit chains, but only a FAIL whose repair the engine opened (`repair_opened: true`).
- **Final review on unit evidence (AIS-HARNESS-3 Wave 3; only with `config.unitReview`).** Unit
  reviews do not replace the final review ([review.md](review.md), Final review on unit evidence).
  After the refusals above, `gate review` also refuses, recording nothing:
  `acceptance_uncovered` when an original's `primary.acceptance_criteria` has no row whose
  `criterion` (or `id`) is an acceptance id mapped on a node (every id of `config.acceptanceIds`),
  and `units_consumed_stale` when an original or a confirmation does not name, in the input field
  `units_consumed: [{unit, evidence_id}]`, every unit exactly once with its current verified
  evidence id (`status.units.<u>.evidence.id`): a missing, unknown, duplicated or old entry is
  refused. The accepted record carries `units_consumed`, and `gate ship-ready` re-checks the record
  that authorizes ship (the last accepted original or confirmation) by the same rule, refusing
  `units_consumed_stale` when a unit's evidence moved since (for example the resolved base moved
  and the units were re-checked and re-reviewed on a byte-identical candidate). `init` refuses
  (`dag_invalid`) `config.unitReview: true` without `config.acceptanceIds`. Without
  `config.unitReview` none of this runs and `units_consumed` is a usage error (exit 1), so the
  final review is unchanged.
- **Known over-review cost (measured in AIS-HARNESS-3 Wave 4, not fixed).** Unit evidence binds a dependency
  unit's evidence id, not the bytes of the contract it shares. When an upstream unit is re-checked
  (after its repair, a rebuild or an input change), every dependent unit's evidence and unit review
  go stale and are re-checked and re-reviewed, even when the shared contract bytes did not change.
  This is safe (it never reuses stale evidence) but spends the parent-wide ceiling and reviewer
  time. A finer binding to the shared contract's fingerprints is deferred until Wave 4 measures the
  cost.
- **Evidence.** The stored check result is bound, as it stands after the checks ran, to the
  fingerprints of the unit's reads and writes, the resolved `config.base` commit, each node's
  attempt count, each dependency unit's evidence, and the attempt count and state of every
  transitive dependency node outside the unit, unit-less ones included (with their declared paths'
  fingerprints): a stale or failed upstream node leaves the unit unverified. Only declared `reads`
  and `writes` are bound; undeclared inputs (test files, lockfiles, config) are not, so declare what
  a check depends on. The candidate id is recorded with it but does not bind it, because another unit's
  writes change the candidate. Validity is recomputed at every use. Any change makes the evidence
  `stale`, together with the units of its dependent closure only (`UNIT_INVALIDATED`, with the
  cause: changed paths, base moved, nodes re-run or a dependency), and the checks run again; a
  fingerprint refresh after a repair is never renewed evidence. Every stale-to-re-check transition is
  recorded as an invalidation first, also between checks inside one drive. Verified evidence invalidated more
  than twice in one run raises `unit_invalidation_storm` (durable) instead of another re-run; the
  owner decides (the decomposition or the contract churns); see the dead ends above.
- **Projection.** `status.units` and the `eval` report's `units` list per unit `state`
  (`verified|stale|failed|pending`), `nodes`, `deps`, `acceptance`, `checks`, current
  `fingerprints`, `evidence` (`id`, `state`, `candidate_id`, `base_commit`, per-check results),
  `stale_cause`, `invalidations` and their `causes`, `clears` once the owner cleared it, and with
  unit reviews its `review` (`state`, `awaiting`, `terminal`, `review_execution`, `evidence_id`,
  `reviewed_evidence`, `risky`, `risk_labels`, `records`). It is computed, never authority.

**REVIEW freeze versus finding-bound REPAIR.** After the freeze (`gate review`
records the frozen candidate), drift is a judgment point (`post_freeze_drift`).
The authorized exception is one REPAIR opened by a `gate review` FAIL: the gate
enqueues `repair-<review_execution>` with the finding-bound write set (the paths its
findings name plus the declared repair ownership) and the brief named by
`repair_prompt_file`; `drive` dispatches it only while the work tree is still the frozen
candidate (any drift since the freeze, even outside every node and the write set, is
`post_freeze_drift` on the repair: nothing is launched and it is never absorbed into the repaired
candidate). Writes outside it are `repair_outside_findings`. An original FAIL with `overflow`
(primary or second opinion) is terminal: it is recorded but opens no repair (`review_terminal`, a
judgment point), so no confirmation or `SHIP_READY` follows without a RUN-STATE `RETRY` linked to
it. On completion the engine appends `{kind: "repair",
review_execution, old_candidate, new_candidate, write_set}` to the review chain,
re-freezes on the new candidate and records the affected closure in
`status.confirmation`; then `gate review` with `kind: "confirmation"`, then `gate
ship-ready`. REPAIR authorization comes from engine state (the review chain), in
the engine and in `carrier.mjs` whenever a state file exists; the carrier's
timing-log check is only the fallback when no state file exists, and a missing or
unwritable log only degrades telemetry. A repair goes through the RED barrier (it
inherits the prerequisites of every node whose writes it overlaps) and budget
admission like a node.

**Round counters** follow `SKILL.md`: at most two consolidated PROVE repair
batches per ticket in total; one REVIEW repair and one confirmation per
authorized review execution (`rounds.review_repairs[<review_execution>]`; a unit review execution:
`rounds.unit_review_repairs[<review_execution>]`, present once one ran).
Beyond them, or after a terminal failure, is `round_limit`: it needs an
explicitly authorized retry. A counter moves only when the dispatch is actually
launched, never on a refused one; an automatic infra retry of a review repair re-dispatches
within the round it already holds. Counters are never reset.

**`mark`** accepts only `failed->pending` (counts as a retry, capped at 1) and
`pending->cancelled`, with a reason. It cannot mark nodes done, create gate
evidence, change ownership, enable API billing or reset a counter; any other
transition or extra key is `mark_refused`. `failed->pending` clears the node's judgments
and every **spent** judgment: a `quiescence_unknown` whose every attempt has since been retired
(its group proven gone), such as a RED or proof runner's. The MARK event records them as
`cleared_judgments` (`[{code, node}]`), with the reason as the authorization. `resume` clears
spent judgments the same way and records them on its RESUME event, so a spent runner judgment on
a run with no failed node is not a dead end. The retry cap is unchanged.

**Judgment points** (`status.judgments[].code`) stop the engine and go back to
the orchestrator or user: `run_mismatch`, `approval_mismatch`, `dag_mismatch`,
`crash_with_writes`, `quiescence_unknown` (always on Windows, where descendants
can outlive the leader: known limit N7 below),
`ownership_violation`, `ownership_unavailable`, `post_freeze_drift`,
`repair_outside_findings`, `repair_unauthorized`, `round_limit`, `budget_stop`,
`red_invalidated`, `red_required` and `candidate_unavailable`; with units also
`unit_check_failed`, `unit_invalidation_storm` and `parent_ceiling`, and with unit reviews
`unit_review_terminal`. The gate adds
unsupported RED runner output, `dispatched_before_red` and a terminal overflow FAIL
(`review_terminal`) (all returned with `judgment_point: true`; the CLI exits 2); its
`units_unverified` and `unit_reviews_missing` refusals are not judgment points (`drive` runs the
checks; the orchestrator relays the unit reviews).

**Budgets.** `config.budget` holds dispatch thresholds: a warning at 80%, and at
100% no new dispatch (`budget_stop`, a judgment point). Before every node **and
repair** dispatch the engine re-reads its own records plus `<TICKET>.usage.jsonl`,
deduplicated by `source_execution_id`, and evaluates `phase_tokens` with the
dispatching item's phase. Work in flight can overshoot, and that is reported.
Unknown usage (including a malformed import line) sets the `budget_unenforceable`
flag rather than counting as within budget; the engine does not stop on it.
`status.budget` shows the ticket and phase state (`ok|warn|stop_dispatch|unknown`)
and the flags, plus `phase_unknown` (`{records, tokens}`) when imported usage carries no phase. Budgets never change review or model policy.

## Gate verifier

`scripts/gate.mjs` is a library of decisions; a refusal is returned as `{ok,
code, reasons}`, never thrown. Gate state is authoritative in the engine state
file; timing logs stay best effort and never block.

- **`gateRed`** is a scheduler prerequisite: a node whose dependency has `redSpecs`
  is not dispatched until RED is accepted, repairs included. The engine runs the
  DAG-bound runner itself: `gate red` input is `{node, command?, specs?}`, where
  `command` only names a formatted `config.testCommands` entry; the command, its
  format, the timeout and the node's `resources` never come from the input. It runs
  with a bounded timeout, its own process group and the resource locks
  under the same durable attempt protocol as workers, so a surviving runner
  holding a lock is reconciled, not re-run. A runner (RED or proof) is `exited` only
  after its whole group is proven gone; a group that survives the kill, or whose
  quiescence is unknown, leaves the attempt `unknown` with its locks held and returns
  `quiescence_unknown` (judgment point) with no evidence or proof recorded. When a runner
  changes the approval binding (plan narrative or DAG bytes), its result is dropped
  (`RED_DROPPED`) and the binding code is returned as a judgment point; the binding is
  re-verified before RED evidence or local proof is committed, so drifted evidence never
  reaches disk. Runner adapters (`parseRunnerOutput`):
  `node --test` TAP (including nested subtests), vitest JSON, jest JSON. RED needs
  every named spec to report an **assertion** failure; import, compile and
  collection errors do not count. Unsupported output cannot establish RED: that
  is a judgment point and the manual flow applies, marked degraded. Evidence is
  bound to the spec files' content digests, the baseline candidate and the resolved
  `config.base` commit, ordered by event sequence, and is refused if recorded after a
  dependent production dispatch. Before a drive dispatches a dependent (or repair) that
  needs it, a changed spec digest or a moved `config.base` drops the evidence
  (`RED_INVALIDATED`, kept in `gates.red_invalid` with the old evidence) and the engine re-runs
  RED itself with the recorded runner and specs, once per invalidation (`RED_RERUN`; it ignores
  dispatches before the invalidation). The `red_invalidated` judgment names the re-run's attempt
  and outcome. Accepted: that drive stops, the next one dispatches. Refused (typically
  `spec_not_failing`, because dependents already implement the specs): every later `drive` and
  `status` reports it until `gate red` is accepted, or the spec files and `config.base` are
  restored to the old evidence's bytes (`RED_RESTORED`); otherwise the owner decides. A
  dependent's own writes never invalidate it.
- **`gateReview`** accepts a review only when bound together: the complete primary
  artifact (the `references/review.md` output contract), a reviewer identity
  distinct from every builder, the frozen candidate ID, coverage, parity and
  security outcomes, the second-opinion artifact with its route and candidate,
  and the reconciliation record. Nested rows are validated: `reviewed_paths`,
  `coverage_partitions`, `acceptance_criteria` and `rule_rows` must be non-empty with
  their review.md fields, and every outcome must be in its enum. Identities are
  written `<provider>:<model>[:suffix]`; a reviewer equal to (or extending) any
  builder identity the engine recorded is `reviewer_is_builder`, and a builder recorded as
  `<provider>:provider-default` (no `modelMap` entry, so the CLI's unknown default) matches
  every reviewer of that provider, and the primary and
  second opinion must differ (`reviewers_not_distinct`). It tracks the original →
  repair → confirmation chain by `review_execution`. Counts or a route name alone
  are never accepted. An accepted FAIL returns the finding-bound `repair` write set.
  Through `run-engine.mjs gate review`, the reviewed candidate is the frozen one: a
  new original review after any earlier original (a FAIL or the freeze) needs a
  RUN-STATE `{event: "RETRY", run_id, review_execution, predecessor, authorized_by}`
  naming the previous execution and trusted by the engine (`retry_unauthorized`
  otherwise; a fresh id alone is refused; a matching but untrusted line is a judgment point), and an accepted FAIL needs `repair_prompt_file` (`repair_prompt_missing`).
- **Candidate integrity.** The exclusion list is pinned: exactly the ticket plan
  file and `session-log.md`, order-insensitive; directories or extra entries are
  refused. Parity and VAPT evidence stay inside the candidate and are finalized
  during PROVE; the reviewer's verdict plus the digest of the artifact it graded
  live in gate state.
- **`gateShipReady`** emits `SHIP_READY` only when the current candidate equals the
  reviewed one, the exclusions are unaltered, graded artifact digests still
  match, the review chain is accepted, every required node is done or cancelled,
  no attempt is live, no repair is open, no judgment is unresolved
  (`nodes_unfinished`, `attempts_live`, `repairs_open`, `judgments_unresolved`), local
  proof is bound to that candidate, and every required risk evidence is present (a `-spec`
  kind needs accepted RED on that file; any other kind must name an existing file inside the
  repository, checked by the engine).
  Local proof is produced by the engine running every `config.testCommands` entry
  (exit 0 = pass) under the runner protocol; an input `local_proof` is a usage
  error. A proof command that changes the work tree is refused as
  `candidate_mismatch`, and one that changes the approval binding (the excluded plan
  narrative or the DAG bytes) is refused with that binding code and its proof dropped; no
  `SHIP_READY` is recorded. A proof runner without proven quiescence records no proof
  and leaves a durable `quiescence_unknown`. Overflow on either reviewer makes PASS
  `outcome_inconsistent`. Remote CI is still checked afterwards, as today. No successful
  closure is ever synthesized.
- **Risk → evidence** (`RISK_EVIDENCE` in `harness.mjs`, additive; no label
  removes a gate): concurrency → `interleaving-spec`; auth, security →
  `authorization-spec`, `negative-spec`; tenancy → `cross-tenant-spec`; payments →
  `failure-path-spec`, `idempotency-spec`; migration, schema → `replay-check`,
  `rollback-compat-check`; ui → `parity-measurements`. Each needs a path, and
  kinds ending in `-spec` also need accepted RED. Presence is checked in code;
  the reviewer judges adequacy.

## Eval report

```bash
node <SHIP_TICKET_SKILL>/scripts/eval.mjs report --repo <R> (--ticket <T> | --all) [--usage <usage.jsonl>...]
```

Read-only (`ship-ticket-eval-v1`). Reads the run log, the engine state and usage
files; anything a source does not carry is `unknown`, never zero. Metrics: tokens
by role and by phase (`phase unknown` for records without one) and the orchestrator share, wall clock per phase, review and repair
rounds, pre-ship findings by severity (from `gate review` records), resume
attempts and outcomes, infra retries, admission refusals, `units` (the per-unit
projection above) when the run has units, and `truncated_outputs` when an attempt's output passed
the capture cap. Exactly three
suggestions exist and are printed, never applied: orchestrator share above 50% →
split the session; review/build above 1.2 on a UI ticket → run the parity probe
first; more than one REVIEW repair → the brief was too weak.

## Docker ownership

```bash
node <SHIP_TICKET_SKILL>/scripts/docker-lifecycle.mjs labels <owner> <run-id>     # --label args for docker run
node <SHIP_TICKET_SKILL>/scripts/docker-lifecycle.mjs reuse <owner> <run-id>      # running owned containers
node <SHIP_TICKET_SKILL>/scripts/docker-lifecycle.mjs orphans <owner>             # crash recovery, read-only
node <SHIP_TICKET_SKILL>/scripts/docker-lifecycle.mjs cleanup <owner> <run-id>    # dry run
node <SHIP_TICKET_SKILL>/scripts/docker-lifecycle.mjs cleanup <owner> <run-id> --apply
```

Only containers with both exact labels (`ai-skills.ship-ticket.owner`,
`ai-skills.ship-ticket.run`) are ever eligible. `--apply` re-inspects each
container's labels immediately before `docker rm -f` and stops at the first
mismatch. A Docker error fails the command; it is never read as "nothing owned".
After a crash, `orphans` lists the owner's runs and removal still goes through
the per-run `cleanup`.

`reuse` returns every running container of the owner and run, across all of
that run's environments. Treat each ID as a candidate only: before attaching,
confirm with `docker inspect` that its published ports, datastore and image are
the intended environment's. If none matches, start a new labelled container;
never attach to the first ID returned. Images, volumes and networks are never removed, and there
is no prune.

## Known limits

- Admission is advisory: it measures, it does not reserve memory.
- Cross-process locks between two concurrent ship-ticket runs on one host are not
  provided. Declare `port:`/`db:` locks within a run and use distinct ports per run.
- Gemini/Antigravity adapters are template-only (above).
- **N7, Windows (not a supported engine target).** Process-group quiescence cannot be proven on
  Windows, so every engine attempt ends in `quiescence_unknown` and its node `failed`: no node
  reaches `done` and no Windows run completes through the engine. `mark failed->pending` cannot
  change that. The Windows CI job runs the harness tests that do not need a node to reach
  `done`; the ones that do are skipped with an N7 reason. The carrier's own dispatch and shim
  resolution are exercised there.
- Worker worktree isolation and join are deferred: ownership checks plus content
  fingerprints cover today's failure modes.
- Gate decisions are recorded with `run-engine.mjs gate red|review|ship-ready|unit-review
  --repo <dir> --ticket <key> --run-id <id> --input <json-file>`: under the engine
  lock it computes the candidate itself (pinned exclusions), calls `gate.mjs`,
  commits the result and, on ship-ready, appends `SHIP_READY` to RUN-STATE once.
  Exit 0 accepted, 2 refused or judgment point, 1 usage error.
- Real-ticket savings are not measured. The plan's fixture benchmark and an
  `eval.mjs` comparison against the SCRUM-140/96/393 baseline are still to be run
  on a real ticket; do not quote a saving.
- Windows behavior of the shims is covered by unit tests and the Windows CI job
  with a fake CLI. Real Claude/Codex Windows installs were not exercised.
