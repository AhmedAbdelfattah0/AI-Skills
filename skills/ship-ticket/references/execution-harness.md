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
