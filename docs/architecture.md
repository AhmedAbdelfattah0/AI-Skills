# Architecture

This repository is a library of skills plus the Node scripts that make one of them, `ship-ticket`,
enforceable. There is no application to build; the artifacts are the skills.

## Layers

| Layer | Where | Role |
|---|---|---|
| Skills | `skills/<name>/SKILL.md` | Instructions an agent loads when a request matches the skill's `description`. Optional `references/` are loaded on demand, `scripts/` are executed. |
| Execution engine | `skills/ship-ticket/scripts/` | Node scripts that turn the written rules into checks at the process boundary: scheduler, writer carrier, run engine, gates. |
| Library CLI | `scripts/cli.mjs` | `list`, `install`, `update`, `autoupdate`, `validate`. Dependency-free Node, runs on Windows, macOS and Linux. |
| Validator and CI | `scripts/cli.mjs validate`, `.github/workflows/validate.yml` | Lints every skill and runs the test suites. |

## ship-ticket structure

`SKILL.md` is a six-phase spine (UNDERSTAND, PLAN, BUILD, PROVE, REVIEW, SHIP) that owns the phase
table, invariants and the resume contract. Everything one phase needs lives in
`references/<phase>.md` and is loaded only when that phase starts. The operator card
(`execution-harness.md`) is read before BUILD; `harness-internals.md`, `units.md`, `test-kinds.md`
and `sprint.md` are opened only when named.

## Engine components

| Script | Responsibility |
|---|---|
| `harness.mjs` | Wave schedule, live host admission, model tiers. |
| `carrier.mjs` | Dispatches approved writers with ownership checks and provider-reported usage. Refuses PLAN and REVIEW. |
| `run-engine.mjs` | Drives the approved task graph and keeps durable, resumable state. |
| `gate.mjs`, `ship-ready-check.mjs` | Verify the RED, review and ship-ready gates. |
| `candidate-id.mjs` | Hashes every changed and untracked path relative to the merge base, so reviewed bytes are identifiable. |
| `brief.mjs` | Builds and lints the worker brief; computes the plan digest; checks the planning-debate attestation. |
| `base-drift.mjs`, `ci-classify.mjs`, `check-pr-scope.mjs` | Detect base drift, classify CI results, check pull request scope. |
| `run-log.mjs`, `run-summary.mjs` | Timing telemetry stored under the repository's Git metadata, never in the worktree. |
| `host-admit.mjs` | Admission check before heavy work (macOS). |
| `wave.mjs` | Wave manifest verification and status. |

State lives under the target repository's Git common directory (`ai-skills/ship-ticket/`), not in
the worktree, so it does not alter the reviewed candidate.

## Parallelism

Every phase derives ready nodes with explicit inputs, write ownership and exclusive resources, and
runs independent nodes concurrently. Serial execution needs a real dependency, overlapping writes,
shared mutable state or unavailable concurrency. Writing workers receive disjoint owned paths and
never run Git operations. The orchestrator owns shared seams and joins.

## Cross-skill conventions

- `code-quality` is the front door for rules; `test-quality` and `docs-accuracy` are adjacent guards
  it routes to; `vapt` is the only skill that runs code under attack.
- A skill may point at a sibling's reference file by relative path, and must carry a one-sentence
  fallback so a standalone install still degrades gracefully.
- Spec artifacts go under `.specs/<skill-name>/`; no third root is introduced.

The canonical, detailed statement of these conventions is [AGENTS.md](../AGENTS.md).
