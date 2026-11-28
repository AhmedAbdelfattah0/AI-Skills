# Adaptive execution

How the factory fits effort and assurance to the work. The short version: the planner labels, the
person approves, the engine enforces. This page says which part owns what, and where the edges are.

Ownership words used below:

- **Agent procedure**: the agent or orchestrator does it by following the skill.
- **Person-approved**: a person approves it, usually as part of the plan.
- **Engine-enforced**: a Node script computes or refuses it.
- **Review-assured**: independent review checks it.

The engine-enforced rows apply to runs the orchestrator drives through `run-engine.mjs`. The
hand-run flow in [execution-harness.md](../skills/ship-ticket/references/execution-harness.md) uses
the same scripts step by step.

## Planning and authorization

| Capability | Owner | What it does |
|---|---|---|
| Ticket classification (size, complexity, scope, risk, STANDARD or ELEVATED) | Agent procedure, person-approved | The planner writes `review_profile`, per-node `risk[]` and `complexity`; the person approves them with the plan. The engine checks the vocabulary of the labels and enforces their consequences; it does not classify a ticket. |
| Structural risk floor (`risk-floor.mjs`) | Opt-in per repository; engine-reassessed on test-kinds runs, advisory otherwise | A repository may declare path globs in `.ship-ticket/risk-paths.json`. A match can only raise the review profile to ELEVATED, never lower it. Advisory unless the run is bound with the test-kinds policy. |
| Planning debate | Agent procedure, engine-checked record | The counterpart model challenges the plan. `CONVERGED` needs a schema-valid agreement on the exact final plan digest (`brief.mjs debate-check`); anything else is `UNRESOLVED` and goes to the person. |
| Human plan approval | Person-approved | Approval happens in the host's plan mode. |
| Approval digest binding | Engine-enforced | The START event carries `approved_plan_digest` and the task-graph digest is bound; a change is refused (`approval_mismatch`, `dag_mismatch`). |
| Scope contract | Engine-enforced, orchestrator runs it | `check-pr-scope.mjs` classifies changed files as planned, supporting or material. |
| Owner-only decisions | Person-approved | Waivers, scope change, security exceptions, destructive actions and merge are defined stop points that hand control to the person. |

## Execution

| Capability | Owner | What it does |
|---|---|---|
| Risk label to required evidence | Engine-enforced | `gate ship-ready` refuses with `missing_risk_evidence` unless each label's evidence kinds exist. |
| RED gate | Engine-enforced | Where labels or `redSpecs` are declared, the engine runs the spec and accepts RED only when an assertion fails. |
| Model tiers | Engine-enforced label, host-mapped | `routeModel` returns `strong` for a REVIEW phase label, any risk label or high complexity (the engine never dispatches REVIEW; the orchestrator runs reviews); `economy` for low complexity; otherwise `inherit`. Tiers are labels the host maps to real models. |
| Strong-tier mapping | Engine-enforced | On a verified adapter, `strong` without a `modelMap.strong` entry is refused, not downgraded. `inherit` without a mapping runs the CLI default and is flagged `provider-default`. |
| Escalation | Engine-enforced, static | A repair inherits the risk labels of the nodes it overlaps. Escalation is by label, before dispatch; a failed attempt is not retried on a stronger model. |
| Worker assignment | Agent procedure, person-approved | The plan assigns work and owned paths to each node; the engine dispatches each node's prompt to the configured provider CLI. |
| Companion skills | Agent procedure | The orchestrator loads `code-quality`, `test-quality`, `docs-accuracy` and `vapt` per phase; a missing companion is a declared degradation. |
| Dependency-aware parallelism | Engine-enforced | Ready nodes run concurrently when writes, reads and exclusive resources do not conflict; plan-time hazards are refused. Without a concurrency-capable carrier the run is serial. |
| Incremental re-run | Engine-enforced | Content fingerprints cover each node's reads and writes. A changed input re-runs that node and its dependents only. |
| Evidence reuse | Engine-enforced, with agent scope selection | Node and unit evidence is reused by fingerprint. Choosing which commands cover which scope is part of the plan. |
| Units and test kinds | Engine-enforced, opt-in | Per-unit checks and reviews, and test-kind obligations, apply to runs that opt in. |

## Resources, ownership, durability

| Capability | Owner | What it does |
|---|---|---|
| In-engine admission | Engine-enforced, estimate-based | Before a second or later concurrent node starts, the engine checks width, the memory budget and `admit` (estimated memory against the sum of node estimates, members at most the CPU count). A refusal is logged as `ADMISSION_REFUSED`. `admit` measures; it does not reserve. |
| Host admission | Agent procedure (orchestrator) | Before heavy work the orchestrator runs `host-admit.mjs`: macOS memory pressure, swap growth, load trend, hysteresis and heavy slots. Elsewhere it prints `platform_unsupported`, which is not an allow. The engine does not call it. |
| Heavy-suite serialization | Host claim store (`host-claims.mjs`) | One heavy slot under pressure; a second slot only when the host is healthy (`heavy_slots_healthy: 2`, `harness.mjs`). Heavy work started through `host-admit.mjs run -- <command>` takes a claim first; occupancy is read from the claims of every worktree on the host, never supplied by the caller. A run with `config.hostClaimRequired` refuses its heavy engine commands without a claim (`host_claim_required`, at the CLI entry). |
| Exclusive resources | Engine-enforced | `port:`, `db:`, `cache:`, `docker:`, `fixture:`, `generator:` and `lock:` names never run together; locks survive a crash. No cross-run locks. |
| Isolation of duplicable resources | Agent procedure | The skill tells the orchestrator to give each node its own instance; `docker-lifecycle.mjs` labels and cleans run-scoped containers. |
| File ownership | Engine-enforced, detect-after | The engine snapshots before and after each worker; a write outside the declared set fails the node (`ownership_violation`, `repair_outside_findings`). Plan roots cannot be owned. Workers share one tree, so the write is not sandboxed or reverted. |
| Durable state and recovery | Engine-enforced (POSIX) | Atomic state, a per-ticket lock, whole-process-group quiescence, an event outbox, and `resume` that reconciles live and dead workers. |
| Post-review drift | Engine-enforced | A changed tree after the review freeze stops the run (`post_freeze_drift`); `rebind` accepts only covered drift. |
| Sprint, wave queue, extended run | Agent procedure, person-supervised | See [sprint-and-extended-run.md](sprint-and-extended-run.md). |

## Assurance, cost and telemetry

| Capability | Owner | What it does |
|---|---|---|
| Review gate | Engine-enforced record checks, review-assured | Requires a complete primary artifact, a second opinion, reviewer different from any builder, primary different from second, both naming the frozen candidate, every finding disposed. The orchestrator runs the reviews. |
| Candidate identity | Engine-enforced | A hash of every changed and untracked path against the merge base; review and ship must name the same id. |
| Ship-ready gate | Engine-enforced | Last review PASS, same candidate, all nodes done, risk evidence present, and the engine runs the plan's `testCommands` itself (`missing_local_proof`). |
| Bounded repair (review) | Engine-enforced | One repair per review execution and one confirmation (`confirmation_spent`, `round_limit`). |
| Corrective iteration (PROVE, gate failures, review RETRY) | Agent procedure (instruction, not an engine check) | The Factory corrects while each round makes progress and returns to the owner after two rounds with none, at a 6-round backstop, or when the approved budget is spent. |
| CI before tracker close | Agent procedure | `ci-snapshot` and `ci-classify` read CI results; the orchestrator closes the tracker item after the PR's CI passes. |
| Security control selection and pairs | Agent procedure, engine-enforced | The model writes the security facts, the selector evaluates them and an unknown fact selects the control. With `securityPolicy` 2, each boundary and control pair needs an accepted RED and a passing named spec. The repository's own measurement did not show useful selection, so no precision or security-improvement claim is made. |
| Token budgets | Engine-enforced, opt-in | `config.budget` ceilings stop new dispatch (`budget_stop`); unknown usage flags the budget instead of reading as 0. |
| Usage capture | Engine-enforced | Provider-reported counters only; unknown stays unknown. |
| Run log and telemetry | Engine tooling, orchestrator-invoked | Best-effort phase timing and events under Git metadata; never blocks. |

## Precise exclusions

These are stated here so the rest of the documentation can stay short.

- No automatic ticket classification. ELEVATED and risk labels are planner output approved by the person.
- Tiers are labels. The host maps them to model ids; the engine does not choose a model by itself.
- No agent registry and no automatic allocation of workers; the plan decides who owns which paths.
- No savings measurement. Token usage is recorded; no token, cost or time saving is claimed or quoted.
- No escalation after a failed attempt.
- Host admission is an orchestrator step on macOS; the engine's own admission is estimate-based.
