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

A missing or failing helper never blocks the ticket: report
`harness degraded: <reason>` and continue under the ordinary `SKILL.md` rules.

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
- `groupPrefix` (the run ID) makes every `parallel_group` unique across phases,
  which `SKILL.md` requires; pass the wave's `parallel_group` to `run-log.mjs`.
  Without a prefix the output says `group_ids_unique: false`.
- `memoryBudgetMb: "auto"` takes the lower of OS free memory and Node's
  cgroup-aware available/constrained memory, minus a reserve of 1 GiB or 15% of
  total, whichever is larger. `memory_safety` is `estimated` only when a budget
  applied and **every** node has `estimatedMemoryMb`; otherwise `unverified`.
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
- Everything else is `inherit`: the host's own model. The harness never
  introduces an implicit downgrade.

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
- **Approval evidence:** `.specs/plans/<TICKET>.md` (or `.spec/plans/`) must hold
  a RUN-STATE `START` event for `runId` whose `approved_plan_digest` equals the
  supplied digest. It reads the plan artifact and never writes it.
- **Billing:** `billing` defaults to `subscription`. The child environment
  drops the provider's API-routing variables (Claude: `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, Bedrock/Vertex/Foundry switches.
  Codex: `OPENAI_API_KEY`, `CODEX_API_KEY`, `OPENAI_BASE_URL`. Gemini/Antigravity:
  Google API-key and Vertex variables). The CLI's own status is then checked in
  that environment: `claude auth status --json` must report
  `authMethod: "claude.ai"` with `apiProvider: "firstParty"`, and
  `codex login status` must report `Logged in using ChatGPT`. Any other answer
  refuses dispatch before a process starts. `"billing": "api"` also needs
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
- **Process control:** async spawn in its own process group. A timeout or
  cancellation (SIGINT/SIGTERM to the carrier, or an AbortSignal) kills the whole
  tree: SIGTERM, then SIGKILL after 5 s on POSIX, `taskkill /T /F` on Windows.
  The carrier captures up to 32 MiB of stdout; beyond that, usage is reported as unavailable.
- **Ownership check:** Git dirty state is snapshotted before and after the run.
  Changed paths outside `ownership.writes` and the declared concurrent
  `othersOwned` fail the node (`ownership_check: "violated"`) and are listed.
  If the directory isn't a Git work tree, the check reports `unavailable`.
- **Output privacy:** stdout shows metadata only. The worker's final message goes
  to a fresh `resultFile` (mode 0600, outside the candidate or under `.git`).
- **Windows:** `.cmd`/`.bat` shims are resolved through `PATH`×`PATHEXT` and run
  with a quoted shell only when every argument is a safe token.

Gemini and Antigravity were not installed where this was built, so their flags
are unverified. They run only from an explicit trusted `executable` + `args`
template. They get no model injection (`model_applied: false`), no usage
parsing, and `subscription_auth: "unverified"`. Antigravity has no documented
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
