# Portable execution harness (opt-in v1)

This is a **deterministic advisory helper**, bundled inside `ship-ticket/scripts/`
so the existing cross-platform installer distributes it with the skill. Node >=18;
no extra package, daemon, service, API key, or model-provider dependency.

**PLAN is protected.** The harness refuses PLAN input and cannot change native
Plan Mode, the strong-model planning choice, cross-model debate, human approval,
or the approved Design Contract. Do not invoke it during native read-only Plan Mode.

## Commands

```bash
node <SHIP_TICKET_SKILL>/scripts/harness.mjs resources
node <SHIP_TICKET_SKILL>/scripts/harness.mjs schedule /absolute/path/to/wave-input.json
node --test <SHIP_TICKET_SKILL>/scripts/harness.test.mjs
```

Example input (write it outside the candidate or under Git metadata; never add
the file to the ticket's reviewed candidate):

```json
{
  "phase": "BUILD",
  "maxConcurrency": 3,
  "memoryBudgetMb": 12000,
  "nodes": [
    {
      "id": "frontend",
      "deps": [],
      "reads": ["contracts"],
      "writes": ["apps/web"],
      "resources": ["cache:frontend-build"],
      "estimatedMemoryMb": 2500,
      "complexity": "medium",
      "risk": []
    },
    {
      "id": "backend",
      "deps": [],
      "reads": ["contracts"],
      "writes": ["apps/api"],
      "resources": ["db:integration"],
      "estimatedMemoryMb": 3500,
      "complexity": "high",
      "risk": ["auth"]
    },
    {
      "id": "integration",
      "deps": ["frontend", "backend"],
      "reads": ["apps/web", "apps/api"],
      "writes": ["tests/integration"],
      "resources": ["db:integration"],
      "complexity": "medium"
    }
  ]
}
```

The result contains ordered `waves`, each with a fresh `parallel_group` and
`model_tier` recommendation. It **does not launch agents**, reserve resources,
measure model tokens, detect subscription quotas, start/stop Docker, or enforce
model selection. The orchestrator must verify actual carrier isolation, exclusive
runtime ownership, available memory, context and reviewer independence before
dispatch. A wave is a safe candidate grouping, not a command to run it blindly.\nOptional `memoryBudgetMb` is a caller-chosen **conservative** budget, and\n`estimatedMemoryMb` is a per-node estimate; the planner rejects nodes larger\nthan that budget and prevents concurrent estimates exceeding it. Neither is\nmeasured or enforced against OS memory, and unspecified estimates default to\nzero. For memory-sensitive dispatch, provide measured estimates for **every**\nnode or do not claim memory safety.

Paths are repository-relative and conflict when a writer owns a path or its
ancestor/descendant; read/write collisions also serialize. Resources use named
exclusive locks: `port:`, `db:`, `cache:`, `docker:`, `fixture:`,
`generator:`, `lock:`. Every worker must declare its real exclusive resources.
An omitted lock cannot be detected by this helper.

Model tiers are `economy`, `balanced`, `strong`, `inherit`. These are
provider-neutral labels, **not actual model IDs**. Security-sensitive nodes,
high-complexity nodes and every REVIEW node receive `strong` advice. The host
must map tiers to available provider models and retain all independent-review
and elevated-security gates. If the host cannot safely select a model, use its
existing model and report the optimization as unavailable; never downgrade
correctness, planning or review.

`resources` reports a best-effort host-wide snapshot, not a cgroup-aware
capacity limit or a memory reservation. Do not use it alone to promise that
simultaneous builds fit in RAM. No automatic Docker deletion is implemented:
safe cleanup needs owned-resource provenance and cannot prune unrelated images,
volumes, databases or developer work.

## Rollout and safety

- Default remains the existing skill DAG behavior; this helper is opt-in.
- Never edit PLAN references or the approved Design Contract to fit a schedule.
- Never treat a computed wave as approval to exceed the host's concurrency limit.
- Do not record source code, prompts, credentials, full paths or token contents in
  telemetry; existing `run-log.mjs` remains the run-time evidence source.
- If this helper fails or is missing, report `harness advisory degraded` and
  follow the existing `ship-ticket` scheduling rules.
- Run `node --test skills/ship-ticket/scripts/harness.test.mjs` on changes.

## Follow-on scope (not implemented in v1)

Measured token/provider usage where host APIs expose it; cgroup-aware admission
control; an owner-scoped Docker/database lease registry with TTL and verified
cleanup; provider-specific dispatch adapters and integration tests on macOS and
Windows. These require separate evidence and should not be presented as shipped.

## Guarded provider dispatch, usage and Docker ownership

```bash
node <SHIP_TICKET_SKILL>/scripts/carrier.mjs inspect /absolute/path/to/dispatch.json
node <SHIP_TICKET_SKILL>/scripts/carrier.mjs run /absolute/path/to/dispatch.json
node <SHIP_TICKET_SKILL>/scripts/usage.mjs summary /absolute/path/to/usage-events.json
node <SHIP_TICKET_SKILL>/scripts/docker-lifecycle.mjs labels <owner> <run-id>
node <SHIP_TICKET_SKILL>/scripts/docker-lifecycle.mjs cleanup <owner> <run-id>
node <SHIP_TICKET_SKILL>/scripts/docker-lifecycle.mjs cleanup <owner> <run-id> --apply
```

Carrier input must include `phase` (BUILD/PROVE/SHIP only), `provider`
(claude/codex/gemini/antigravity), `approved: true`, `approvedPlanId`,
absolute `workdir`, `ownership.writes`, trusted `args` string array, and
`timeoutMs`. Antigravity additionally requires an explicit executable because
there is no assumed universal CLI. The harness **does not construct prompts,
inject model flags, check authentication, or verify plan approval independently**;
the orchestrator must supply and validate these. Claude subscription-only mode
removes API-key environment variables from the child process, but the orchestrator
must still verify actual OAuth subscription authentication and provider routing
before dispatch. Never use carrier for PLAN or independent REVIEW. Avoid passing
sensitive prompts or secrets through argument lists.

Usage input is an array of provider-reported events with `provider`, safe
`run_id`, and optional `input_tokens`, `output_tokens`,
`cache_read_tokens`, `cache_write_tokens`, `reported_cost_usd`. It only
aggregates provided numbers. Missing counters stay null; subscription quotas
and model billing are not inferred.

Docker containers must be created with the two exact labels returned by
`labels`: `ai-skills.ship-ticket.owner` and `ai-skills.ship-ticket.run`.
Default cleanup is a dry run; `--apply` requires explicit authority and verifies
the labels again for every container. The helper is not a shared resource lease
manager and does not clean Docker networks, images or volumes. A container
without both exact labels is never eligible.

**Operational limits:** model IDs/CLI flags are version-specific and deliberately
provided by the trusted host. Memory estimates are advisory. Real provider
availability, token telemetry, and resource cleanup need host integration and
appropriate permissions; do not report these as automatic or guaranteed.
