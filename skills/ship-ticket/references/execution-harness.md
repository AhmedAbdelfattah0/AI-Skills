# Execution harness (BUILD, PROVE, SHIP; never PLAN)

Bundled dependency-free Node helpers (Node >= 18) under `ship-ticket/scripts/`,
distributed by the existing installer with the skill. They make the existing
dependency-driven orchestration measurable and enforce its safety rules at the
process boundary. They do not replace the DAG, approval, reviewer independence
or security gates in `SKILL.md`.

**PLAN is protected.** Every helper refuses PLAN. None of them selects a PLAN
model, schedules PLAN work, shortens the debate or touches approval. Do not run
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
| BUILD | `schedule` the approved DAG, `admit` each wave, `carrier.mjs run` each writer node, `docker-lifecycle.mjs labels` for any container |
| PROVE | `schedule` checks with exclusive `port:`/`db:`/`docker:` locks; `docker-lifecycle.mjs reuse` before starting a service; carrier only for writer repairs |
| REVIEW | `schedule` advice only; dispatch stays on the read-only relay |
| SHIP | `usage.mjs summary` for the run; `docker-lifecycle.mjs cleanup` dry run, then `--apply` for this run's containers |

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
  On macOS, free memory excludes reclaimable cache, so the budget is conservative.
- `admit` input `{ "phase", "estimatedMemoryMb", "members" }` re-reads live
  memory immediately before a wave starts. A refusal shrinks or delays that wave,
  never the plan. Neither command reserves memory.
- Default `maxConcurrency` is `min(3, cpu_count)`.

### Model tiers

Tiers are `economy`, `balanced`, `strong` and `inherit`. They are labels the host
maps to real model IDs, not model IDs themselves.

- REVIEW, any high-risk node (`security`, `auth`, `tenancy`, `payments`,
  `migration`, `schema`, `shared-contract`) and `complexity: "high"` are always
  `strong`. A requested cheaper tier cannot override that.
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

- **Phase:** BUILD, PROVE and SHIP only.
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
- **Output privacy:** stdout shows metadata only. The worker's final message goes
  to a fresh `resultFile` (mode 0600). Output paths are canonicalized through
  symlinks and must be outside the repository work tree or inside its real Git
  metadata directory. A failed result or usage write is reported in
  `telemetry_degraded` and never discards the execution outcome.
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

Each run appends one JSONL event to `usageLog`; `run_log_metrics` gives
`key=value` pairs for `run-log.mjs end --metric` (see
[observability.md](observability.md)).

```bash
node <SHIP_TICKET_SKILL>/scripts/usage.mjs summary /abs/scratch/usage.jsonl
```

- Claude `--output-format json` gives `input_tokens`, `output_tokens`,
  `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens` and
  `reported_cost_usd`, plus its `cost_basis`. Under a subscription the basis is
  `list`: a list-price estimate, **not a charge**.
- Codex `exec --json` sums `turn.completed.usage` over all turns. Codex reports no
  cost, so cost stays `null`.
- Missing counters stay `null` and are never zero. `cache_hit_ratio` (cache reads
  ÷ all prompt tokens) is the measured token-optimization signal.

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
the per-run `cleanup`. Images, volumes and networks are never removed, and there
is no prune.

## Known limits

- Admission is advisory: it measures, it does not reserve memory.
- Cross-process locks between two concurrent ship-ticket runs on one host are not
  provided. Declare `port:`/`db:` locks within a run and use distinct ports per run.
- Gemini/Antigravity adapters are template-only (above).
- Windows behavior of the shims is covered by unit tests and the Windows CI job
  with a fake CLI. Real Claude/Codex Windows installs were not exercised.
