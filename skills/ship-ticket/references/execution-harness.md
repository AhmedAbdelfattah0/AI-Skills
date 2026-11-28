# Execution harness (BUILD, PROVE, SHIP; never PLAN)

Bundled dependency-free Node helpers (Node >= 22) under `ship-ticket/scripts/`,
distributed by the existing installer with the skill. They make the existing
dependency-driven orchestration measurable and enforce its safety rules at the
process boundary. They do not replace the DAG, approval, reviewer independence
or security gates in `SKILL.md`.

Mechanism and rationale are in [harness-internals.md](harness-internals.md), read on demand; rules for nodes that carry `unit` are in [units.md](units.md).

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
ownership controls. On an ELEVATED or security-sensitive run, falling
back to the manual flow after plan approval is **WAIT_FOR_USER** at fallback time
(SKILL.md); a STANDARD run records `harness degraded` with a warning. A *safety refusal* blocks and is never bypassed by falling
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
- `memory_safety` is `estimated` only when a verified
  budget applied and **every** node has `estimatedMemoryMb`; otherwise it is
  `unverified`.
- `admit` input `{ "phase", "estimatedMemoryMb", "members" }` re-reads live
  memory immediately before a wave starts. A refusal shrinks or delays that wave,
  never the plan. Neither command reserves memory.
- `admitHost(snapshot, cls, running, history)` (library function in `harness.mjs`, pure, no I/O; the
  reader is `hostSnapshot()`) decides whether ONE more task may start from kernel-sourced health only
  (macOS memory pressure, swap USED growth, load averages, injected provider errors) and the caller's
  `running` occupancy. It is fail-safe: any invalid snapshot, history or argument holds
  (`snapshot_unavailable` / `invalid_args`), including every non-darwin host without an injected valid
  snapshot; there is no fallback admit and it never terminates running work. HEAVY cap is 1, or 2 only
  when healthy. Memory pressure: level 1 is normal, level 2 (`warn`) is a NON-BLOCKING warning reported as
  the boolean signal `pressure_warn` (not a hold reason), and only a sample at level 4 (`critical`) anywhere
  in the window holds with `held_pressure`; level 1 and 2 samples both count as clean for hysteresis. Level 2 never blocks, but it does not open the second HEAVY slot: that needs level 1 on every sample of the window (`pressure_warn` is window-wide: any level-2 sample). Level 4 is a
  pragmatic threshold, subject to real-world validation, not a proven safety boundary; swap growth, load and
  provider errors keep their own holds. Hold reasons: `held_pressure`, `held_swap`, `held_load`, `held_provider`, `held_heavy`,
  `held_hysteresis`, `held_resample`. Caller contract: a host that is recovering (`held_hysteresis`)
  needs two clean samples, each at least 15 s after the previous counted one, and the next sample must
  arrive within 30 s or the recovery streak restarts. An already-open host also needs counted samples at
  least 15 s apart, and may be polled at up to 3 minutes between counted samples; a longer unobserved gap
  is treated as a cold start (two clean samples again). Unknown snapshot properties are rejected (fail-closed: a new snapshot field holds every call
  until `admitHost` learns it).
  Swap signal (POLICY NOTE, flagged for the owner): the recorded policy says "swap flat (no swapout
  growth)"; `admitHost` uses swap USED growth (above a 2 MB tolerance, strictly greater, between any earlier and later
  sample of the window) from the single-record `sysctl -n vm.swapusage`, the same intent from a numeric
  one-line source instead of multi-line `vm_stat` text; high absolute swap alone never blocks. The snapshot
  schema is `ship-ticket-host-snapshot-v2`. Every kernel input is matched by ONE whole-output grammar (no
  splitting or line selection): pressure `/^[124]\n?$/`, swap `total = N.NNu  used = N.NNu  free = N.NNu`
  with only `  (encrypted)` optional (`u` is K, M or G); any other shape is `snapshot_unavailable`. All swap
  and load decisions use EXACT arithmetic: each `N.NN` is parsed to an integer count of hundredths (BigInt), converted to
  one common integer unit (hundredths of KB), `used <= total` and `total == used + free` are compared exactly (no
  tolerance; values beyond the safe-integer range are rejected, never rounded), growth is an exact integer difference
  compared with the exact 2 MB tolerance, and load is compared as `5*load >= 3*cores`.
- `scripts/host-admit.mjs --class heavy|light [--running N]` is the CLI over `admitHost`/`hostSnapshot`
  for the orchestrator, run before HEAVY work. One invocation takes up to two `hostSnapshot` windows
  (about 20 s per window, so up to about 40 s), carries the history in memory and persists nothing.
  `--running N` is the number of tasks already running (for `heavy` it is the heavy-slot count passed to
  `admitHost`; default 0). It prints ONE JSON line `{admit, reason, reasons, class, running, signals}`
  and exits 0 admit, 1 hold, 2 usage error, unsupported platform or an internal failure (`reason:"error"`). Non-macOS prints
  `admit:false`, `reason:platform_unsupported`: that is NOT an allow; the orchestrator falls back to the
  manual rule (check memory pressure and load itself, run one heavy job at a time). A hold means reduce
  parallelism or wait, then ask again; never terminate running work. Anti-loop rule: re-sample only while the set of hold
  reasons changes; after 2 identical unsafe holds in a row stop, report `host_hold_stable`, and either re-check at most
  once every 5 minutes or ask the owner. An unsafe hold means a hold for memory pressure level 4, swap growth, high load, provider errors or an unusable snapshot; pressure level 2 alone is never a hold.
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
  review round being repaired). It may declare `redSpecs` (repo-relative spec
  paths); then `redEvidence` must be an absolute path to a non-empty file with
  the failing-run output, written by the orchestrator, or dispatch is refused.
- **Plan roots are orchestrator-owned.** A change under `.specs`/`.spec` during a
  run is RUN-STATE bookkeeping: it is reported in `orchestrator_paths_changed`
  and is not a `writes_outside_ownership` violation.
- **Approval evidence (event binding, not content verification):**
  `.specs/plans/<TICKET>.md` (or `.spec/plans/`) must hold a RUN-STATE `START`
  event for `runId` whose `approved_plan_digest` equals the supplied digest. The carrier reads the plan artifact and never writes
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
  refuses dispatch before a process starts. `"billing": "api"` also needs
  `"allowApiBilling": true`, which only the user can authorize.
- **Adapter limits:** `bypassPermissions`, `plan` and
  `danger-full-access` are refused.
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
  `{"tests":[{"cmd","result"}],"red_seen":[],"blockers":[],"needs_outside_ownership":[]}`
  (a repository that declares T0 fast checks adds a fifth key `t0`, accepted when well-formed; see `prove.md`.
  The carrier does not require it; the orchestrator's `fast-checks.mjs verify` does);
  the last block is validated into the message file. A missing or invalid block
  is not fatal: the result says `report: "unstructured"` with the failure reason.

Gemini and Antigravity were not installed where this was built, so their flags
are unverified. They run only from an explicit trusted `executable` + `args`
template. Under subscription billing they
also need `acknowledgeUnverifiedAuth: true`, set only on the user's explicit
instruction and never inferred. They cannot satisfy a `strong` node.

## Provider-reported usage

Each run appends one JSONL event to `usageLog`. The result's `run_log_metrics`
holds `key=value` pairs that `run-log.mjs end --metrics-from <result.json>` imports
(`<result.json>` is the carrier's stdout saved to disk, not `resultFile`)
directly (see [observability.md](observability.md)).

```bash
node <SHIP_TICKET_SKILL>/scripts/usage.mjs summary /abs/scratch/usage.jsonl --run-id <RUN_ID>
```

`--run-id` restricts the sum to one run when the log is shared; without it every
run in the file is summed.

Imports and budgets:

```bash
node <SHIP_TICKET_SKILL>/scripts/usage.mjs import-session <session.jsonl> --run-id <ID> --out <usage.jsonl> [--since iso] [--until iso] [--role orchestrator|reviewer|unattributed] [--subagent-role orchestrator|reviewer|unattributed] [--phase <PHASE>]
node <SHIP_TICKET_SKILL>/scripts/usage.mjs import-codex <relay-result.json> --run-id <ID> --out <usage.jsonl> [--phase <PHASE>]
```

The budget metric
is `processed_tokens = input + output + cache_read + cache_write` (or
`output_tokens`); see Budgets below. With the run engine, import into
`git rev-parse --git-path ai-skills/ship-ticket/<TICKET>.usage.jsonl` (a legacy run; a durable run, the default:
`<git-common-dir>/ai-skills/ship-ticket/runs/<TICKET>/usage.jsonl`): the engine reads
that file before every dispatch.

## Run engine

```bash
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs init   --repo <R> --ticket <T> --run-id <ID> --dag /abs/dag.json
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs status --repo <R> --ticket <T> --run-id <ID>   # the only thing the orchestrator reads
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs drive  --repo <R> --ticket <T> --run-id <ID> [--until <node>]
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs resume --repo <R> --ticket <T> --run-id <ID>
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs mark   --repo <R> --ticket <T> --run-id <ID> --node <id> --transition 'failed->pending' --reason <text>
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs mark   --repo <R> --ticket <T> --run-id <ID> --node <id> --transition 'pending->cancelled' --reason <text>
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs rebind --repo <R> --ticket <T> --run-id <ID> --reason <text>   # accept hand edits to done nodes, only when the tree is the frozen candidate
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs archive --repo <R> --ticket <T> --run-id <ID>   # copy state, engine log, usage and a sha256 manifest to the git common dir; run BEFORE `git worktree remove`
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs reconcile --deadlines true --repo <R> --ticket <T> --run-id <ID>   # durable run only: the persisted-deadline sweep (measurement UNQUALIFIED: it measures and signals nothing yet)
```

The engine runs the process (dispatch, retries, staleness, resume) and leaves
judgments to the orchestrator and the user. It adds no policy: approval,
reviewer independence, billing and ownership checks are the carrier's and
`SKILL.md`'s. `drive` exits 2 on a judgment point; any other failure exits 1.

**Files**, never committed. Every NEW run (S1) is a **durable run** (policy versions 13-24): its ledger `state.json`, the
engine's event file `engine.jsonl`, `lock`, `attempts/` (per-attempt envelopes and outputs) and `usage.jsonl` (imported
orchestrator/reviewer usage, read by budgets) live in one run directory of the git COMMON dir,
`<git-common-dir>/ai-skills/ship-ticket/runs/<TICKET>/`, so `git worktree remove` loses none of them. A run started before
S1 (policy versions 1-12), or a new run under the documented escape hatch (the DAG's `config.durableRun: false`, or
`SHIP_TICKET_PLACEMENT=legacy` in the engine's environment), keeps the legacy placement under
`git rev-parse --git-path ai-skills/ship-ticket/` (in a linked worktree that is its private gitdir): `<TICKET>.state.json`,
`<TICKET>.engine.jsonl`, `<TICKET>.lock`, `<TICKET>.attempts/` and `<TICKET>.usage.jsonl`. Existing runs are never migrated.
The placement of an existing run is read from the filesystem (`scripts/lib/run-placement.mjs`, the one resolver every
reader uses); state in both placements for one ticket is refused (`state_placement_ambiguous`), and `init` reserves the
placement under the common run-directory lock and refuses (`state_exists`) when the ticket already has a state in the
other placement in ANY worktree. A durable run records the worktree that started it: every command except `status`,
`archive` and `reconcile --deadlines` is refused from another worktree (`worktree_mismatch`, before anything is observed or
written); `archive --retire true` is allowed from another worktree only once the owning worktree no longer exists (and then
observes no plan); `reconcile --deadlines` from another worktree never observes the caller's plan and records no result
against the caller's tree. Recovery in a durable run (resume, a later gate, the sweep) signals only a positively verified
group (leader alive with the recorded start time); otherwise the attempt stays `unknown` with its locks
(`quiescence_unknown`), including a dead leader whose group still has members, which then needs ending by hand. Start
times are read time-zone and locale independently. Each launched attempt of a durable run carries a persisted `deadline`
(limit and clock origin, `scripts/lib/deadline.mjs`); the consumed-execution measurement is UNQUALIFIED (its G0 fixtures
have not all passed), so `reconcile --deadlines` measures nothing and sends no signal, and the launcher's in-process timers
remain the only enforcer. The timing log `<TICKET>.jsonl` stays owned by `run-log.mjs`.

**DAG** (`ship-ticket-engine-dag-v1`, `{schema, config, nodes}`). Unknown fields
are refused, never dropped.

- `config`: `provider`, `modelMap`, `permissionMode`, `billing`, `width`,
  `memoryBudgetMb`, `timeoutMs` (clamped to 1 s..1 h for both validation and the
  timer), `budget` (`{ticket_tokens, phase_tokens}`), `candidateExclusions` (exactly
  `.specs/plans/<TICKET>.md` and `session-log.md`, or absent; anything else is
  `dag_invalid` at `init`), `testCommands` (`{<name>: {cmd, args, format?}}`; an entry
  with `format` `tap|vitest-json|jest-json` is a RED runner, and `gate ship-ready`
  runs every entry as the local proof; On an Nx monorepo, the RED runner is the direct Vitest command (`vitest-json`), not
  Nx: Nx prints banner lines before the JSON, so `gate red` refuses it
  `unsupported_output`. "Direct Vitest" applies only when a vitest config exists for the project. An Angular project whose `test` target is
  `@angular/build:unit-test` has no vitest config; its RED runner is an `sh -c` wrapper with `format: vitest-json`:
  `sh -c 'f=$(mktemp "${TMPDIR:-/tmp}/red.XXXXXX") || exit 97; npx nx test <project> --skip-nx-cache --include=<workspace-relative spec> --reporters=json --outputFile="$f" >/dev/null 2>&1; rc=$?; cat "$f"; rm -f "$f"; exit $rc'`
  (it prints only the report file, which is jest-shaped JSON that `parseRunnerOutput('vitest-json')` accepts). Nx stays fine as a PROVE/proof command (measured on a dry run:
  direct Vitest RED accepted, Nx RED refused, Nx PROVE accepted). Choose it before
  approval, because `DAG_BOUND` fixes the runner.), `base`, `riskLabels`
  (ticket-level labels from the closed risk vocabulary plus `ui`; unioned with
  node `risk` for `gate ship-ready`), `acceptanceIds`, `unitRecheckCeiling` and `unitReview` (opt-in; [units.md](units.md)),
  `durableRun` (S1: absent or `{ version: 1 }` is the default durable run; `false` is the escape hatch to the legacy
  per-worktree placement, see Files). Billing is
  `subscription`: the engine CLI has no API-billing switch, so every dispatch of a DAG with
  `billing: "api"` is refused (`dispatch refused: api billing requires allowApiBilling`) by design;
  `allowApiBilling` exists only for a library caller the user authorized.
- node: `id`, `deps`, `reads`, `writes`, `othersOwned`, `resources`, `risk`,
  `complexity`, `modelTier`, `estimatedMemoryMb`, `promptFile`,
  `phase` (`BUILD|PROVE|SHIP`; REPAIR is never a node: the engine dispatches repairs from review
  records only, so a REPAIR node is `dag_invalid`), `role` (`builder|repair|evidence`),
  `evidence`, `redSpecs`, and the opt-in `unit`, `acceptance`, `checks` (see [units.md](units.md)).
- `acceptance` and `config.acceptanceIds` are legal on a DAG without units; [units.md](units.md) applies only when a node has `unit`.

`status` prints the compact `ship-ticket-engine-status-v1` view, including
`red_pending`, `budget` (`{ticket, phase, flags}` or null) and `telemetry_degraded`, and `truncated_outputs` only when an attempt's output passed the capture cap (below).

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

**Policy version (S-27 minimum).** `init` records two more state fields. `policy_version` is
the run's semantics version: `1` for the engine as it was before the field existed, `2` with
test kinds, `3` with a format-3 security block (security obligations), `4` with both, and `5` to `8`
for `1` to `4` with a pinned remote base (below). `skill_commit` is the git HEAD of the checkout that tracks the running `run-engine.mjs`. It
is the literal `unknown` for a copy install, for a copy nested untracked in another repository, and
when git fails. It names HEAD only, not uncommitted edits to the installed scripts. The repository
is found from the script's own directory: inherited `GIT_*` variables such as `GIT_DIR` are not
passed to git. The roadmap's S-27 AC3 says the commit is recorded in START, but it is recorded at
`init`, in engine state. START is an orchestrator-written RUN-STATE line, and the engine does not
write it.

This `policy_version` is the engine-state semantics version. It is unrelated to the
`policy_version: 2` of a `SECURITY_WAIVER` and to `config.securityPolicy` (see [ship.md](ship.md)).
Only the name is shared.

Every command that loads the state checks the run's version before anything else, using
`scripts/engine-policy.mjs` (`policySemantics`). Those commands are `status`, `resume`, `drive`,
`mark`, `clear-unit`, `rebind` and every `gate`. The carrier's REPAIR authorization and
`eval.mjs report` make the same check. A version this engine does not support is refused with
`policy_version_unsupported` and nothing is written. A `gate` reports the refusal as exit 2, and
every other command exits 1. `eval.mjs report` refuses the whole report, naming the ticket. A
present but malformed value is also refused. A state without the key is version 1 and is never
back-filled, so existing runs behave exactly as before. `archive` stays open, so a run that no
installed engine can resume can still be copied out.

This is **not executable pinning**: the engine's scripts still run from disk as installed. A
version records which semantics a run started under; it does not keep the code for them. A later
change to semantics must add a version and keep the old version's code path reachable through its
flags. Otherwise it must drop the old version, so that old runs are refused rather than silently
re-interpreted.

To roll back, revert the PR and check out the earlier commit in the installed checkout
(`git -C ~/.ai-skills checkout <prior main>`). Runs that the newer engine stamped with a version
the older engine lacks are then refused, not resumed.

S1 rollback boundary (durable runs, policy versions 13-24): an engine without S1 (for example 705ae1b) does not refuse a
durable run; it cannot see it. It looks only at the legacy `--git-path` placement, so it reports `no_state` and would `init`
a second, legacy run of the same START beside the durable one (duplicate dispatch); back on S1 the ticket is then refused
as `state_placement_ambiguous`. Before rolling S1 back, finish or `archive --retire true` every durable run, and never
re-`init` one on the older engine. A run that must stay readable by an engine without S1 is started under the escape hatch
(`config.durableRun: false` in the DAG, or `SHIP_TICKET_PLACEMENT=legacy`). Lock and recovery-marker records keep the
705ae1b representation of `process_start_time` and carry the S1 canonical start time in a separate `start_identity`, so an
engine without S1 contending for the same lock still sees a live S1 holder as live.

Reverting this change itself removes the check, and the extra fields become inert. Before a later
slice adds version 2, that revert is safe. After it, the revert would let an engine that knows
nothing of version 2 resume a version 2 run. Never revert a version table that is already in use.

Limits:
- A same-user edit of `policy_version` in `state.json` is neither detected nor prevented. The state
  file is the trust anchor, and any process of the user can rewrite it.
- S1: versions 13-24 are 1-12 plus `durableRun` (every new run; the escape hatch records 1-12). A run's `durableRun` flag,
  its `S.durable` record and its placement must agree at every load (`durable_state_missing` otherwise).
- The resolved semantics (`E.policy`) are consumed by the test-kind activation (`testKinds`) and by
  the check that a run's §3a block format matches `securityObligations`. Tests cover recording,
  preservation and enforcement, including commands that refuse when the recorded version's
  capability flags disagree with the run's state. The first
  slice that adds version 2 must add the test that a version 1 run still takes the version 1 path.
- The R0-S candidate (`ais-p0` `a890b0d`) will conflict with this change mechanically: three hunks
  in `run-engine.mjs` and one in `run-engine-record.test.mjs`. Resolve each by keeping both sides.
  The candidate's `skill_revision`, recorded at enrollment, duplicates `skill_commit`.

**Pinned base (S-12, opt-in).** A DAG with `config.pinnedBase: { remote: "<name>" }` (exactly that
shape, never defaulted, bound by the DAG digest) pins the run's base at `init`. The base branch is
`config.base` when it names a branch, else the default branch the remote names
(`git ls-remote --symref <remote> HEAD`). Its commit is the one the remote names now
(`git ls-remote`), never a local ref. The state records
`base: { remote, identity, ref, sha, merge_base, pinned_at_seq }` and a `BASE_PINNED` event, and the run
records policy version 5 to 8. From then on every base read of the engine (the candidate id, RED and
unit evidence bindings, the test-kind declaration, the reassess diff) uses `base.merge_base` through
one accessor (`baseRef` in `engine-dag.mjs`), so a stale or moved local `main` never changes what the
run measures. That is the TICKET-B latch: a local `main` 26 commits behind origin put the upstream
files into the candidate, and the first `gate reassess` recorded a permanent REAPPROVAL.

`init` refuses, writing nothing:
- `remote_ambiguous`: several `remote.<name>.url` values, several push URLs, or a push URL that is
  neither the fetch URL nor the same repository (checked whatever host the fetch URL names).
- `base_unverified`: no configured URL for the remote (git would read the bare name as a local path,
  such as an in-tree `origin` directory), a detached HEAD, a ticket branch with no upstream, or no
  history shared with the remote base.
- `base_remote_unavailable`: offline, no such remote or branch, no default branch, or the remote
  commit not fetched yet.

A local `config.base` branch whose merge base with HEAD differs from the pinned one is reported as an
advisory `BASE_LOCAL_DIVERGED` event, and the run proceeds.

`gate reassess` re-reads the remote first. None of its refusals latches (`S.security` is not
written), and each is a judgment point:
- `base_remote_unavailable`: fetch and retry.
- `base_moved_remote`: the remote base no longer descends from the pinned commit (a force-push).
- `base_moved_local` with `expected` (the pinned merge base) and `observed`: either the local base
  branch disagrees (reset it, or the owner decides, then retry), or the branch merged or rebased
  onto another base mid-run. In that case, archive the run and start a new one, which pins again.
  The pin is never moved silently.

A remote that advanced with commits the branch lacks has no effect. `status` shows `base_advanced`
in its advisory `base` block, which is never a judgment. A real unapproved delta measured from the
pinned merge base still gives REAPPROVAL.

Every git read derived from a pinned base runs hardened (`engine-base-read.mjs`): no inherited
`GIT_*` variable (so `GIT_DIR`, `GIT_WORK_TREE`, `GIT_CONFIG*` and the like never redirect it), replace
refs off and grafts off. The remote is always given by its one configured URL, never by its name.
`engine-base.mjs` keeps its ported `authGit`; the environment it runs under is supplied by the caller.

A partial pin is never resumed (`base_state_missing`): the policy flag, the `base` key and
`config.pinnedBase` must come together, and `S.base` must be exactly
`{ remote, identity, ref, sha, merge_base, pinned_at_seq }` with full SHAs. A pinned run never falls
back to a local ref. An engine without S-12 refuses a pinned run with
`policy_version_unsupported`. Rollback is the flag: archive the run and start a new one without
`config.pinnedBase`.

Limits:
- The remote is reached through the repository's git config, so a same-user `insteadOf` or
  `remote set-url` can redirect it.
- `ls-remote` uses the user's git config and credential helpers. Inherited `GIT_SSH_COMMAND` and
  `GIT_ASKPASS` are not honored for these reads. The hermetic git runner (S-02a0c) is not used yet.
- Without `config.repoIdentity`, the base is checked at `gate reassess` only (and reported by
  `status`), so a pinned run without `config.securityPolicy 2` gets the accessor but no base check.
- Without `config.repoIdentity`, a remote URL re-pointed at another repository mid-run is not
  detected. With it, the URL is `identity_changed` at every gate (below). A second URL added mid-run
  is refused at the next reassess.
- `state.json` is same-user writable: a tampered but well-formed `S.base` is trusted.
- `base-drift.mjs` is unchanged. It is the standalone, advisory local-ref check that the briefs use.

**Repository identity (S-28a, opt-in).** `config.repoIdentity: true` (exactly `true`, never
defaulted, bound by the DAG digest) requires `config.pinnedBase`. It binds the run to ONE GitHub
repository, trust on first use at `init`. The identity of record is `S.base.{ remote, identity }`,
and no other key holds it. Every remote URL value of the run (fetch and push) goes through ONE strict
parser, `strictGithub` in `github-identity.mjs`. It accepts `https://github.com/<o>/<r>`,
`ssh://[user@]github.com/<o>/<r>` and `[user@]github.com:<o>/<r>` (optional `.git` and `/`). It refuses
any other host, any port, plaintext `http://` and `git://`, an https user part (`https://evil.invalid#@github.com/...`
reaches another host), a user, owner or repo starting with `-`, `.` and `..`, and anything after the repo.
`repositoryOf`, which runs without the flag use, is unchanged. `init` refuses `identity_unbound`,
writing nothing, when the remote names no repository on github.com. It refuses `remote_ambiguous` for
several fetch or push values, or a push value naming another repository. Otherwise it records an `IDENTITY_BOUND` event
and policy version 9 to 12, which is the pinned version 5 to 8 plus `repoIdentity`. An engine without
S-28a refuses 9 to 12 with `policy_version_unsupported`, and never reads such a run as a plain pinned
run.

Each check takes ONE snapshot: the remote's `url` and `pushurl` values from ONE `git config -z
--get-regexp` process, read-only and hardened. The values are NUL-separated, so a value holding a
newline cannot forge a key. The remote name is regex-escaped. Every scope counts (system, global,
local, worktree, `includeIf`), and any git failure is refused. The identity is compared from that
snapshot, and the base is then read by the snapshot's URL: no consumer re-reads the configured URL.
Init, reassess, review and confirmation take one snapshot each; ship-ready takes two, one before its
proof and one after it. The snapshot covers those values only. `ls-remote` is a separate git process
that reads config itself (`url.*.insteadOf`, `http.*`, `core.sshCommand`). At reassess, S-12's own
base check (`pinnedBaseRefusal`) runs by the snapshot, so both modes share one base check.

| Gate | Check, in order | On a pass |
|---|---|---|
| `gate reassess` | the identity, first (so nothing is sent to a re-pointed URL), then S-12's base check | as before |
| `gate review` (original) | the identity, then the remote base against `S.base` (the pin), the merge base, and the local base branch | `S.freeze.base` = the remote head now; `BASE_FROZEN` event |
| `gate review` (confirmation) | the identity, then the remote base against `S.freeze.base` | nothing new |
| `gate ship-ready` | the identity, then the remote base against `S.freeze.base`, before the proof runs and again after it (a proof command can re-point the remote or move the local base; the proof is then dropped) | `S.ship_ready.base` = the freeze base |

The freeze base is exactly `{ remote, identity, ref, sha, merge_base }`. A repair re-freeze keeps
it. SHIP_READY binds it and does not adopt a head that advanced after the freeze. A RETRY re-freeze
of the same candidate moves it.

New codes: `identity_changed` (the remote names another repository, another host or a port, or none), `identity_unbound`
(`init` only) and `identity_state_missing`. The base checks reuse `remote_ambiguous`,
`base_unverified`, `base_remote_unavailable`, `base_moved_remote` (a rewind below the freeze sha)
and `base_moved_local`. Every refusal is a judgment point and none latches. The gate records only
its `GATE` line: no freeze, SHIP_READY, review record, proof or security record. To recover,
restore the URL and retry. A `base_moved_remote` after the freeze needs an owner RETRY (the new
original review freezes the head as it is then). A moved merge base needs a new run.

The load invariant `identity_state_missing` is one-way. The policy flag and `config.repoIdentity`
must agree, and under the flag `S.base.identity` must be non-null and every non-null freeze and
SHIP_READY must carry an exact base record. The converse does not hold: a version 5 to 8 run on a
GitHub origin records an identity too.

With the flag off, the engine behaves as before, byte for byte: no `freeze.base`, no
`ship_ready.base`, and no identity event. Rollback is the flag.

S-28a limits:
- The identity is the CONFIGURED URL. The endpoint behind it is not proven: `url.*.insteadOf`
  applies when `ls-remote` (or a fetch) runs, credential helpers are not checked, and the
  `ls-remote` answer is not attested.
- `pushInsteadOf`, `branch.*.pushRemote` and `remote.pushDefault` are not bound. The engine never
  pushes; binding a push target is S-28b's publication binding.
- The "one snapshot, nothing is sent to a re-pointed URL" guarantee holds for the GATES (init,
  reassess, review, confirmation, ship-ready). `status` is an advisory read (OD-10): its `base` block
  still reads the configured URL. On a run whose origin was re-pointed, it can therefore contact the
  re-pointed URL and report that remote's head as an advisory. It decides and writes nothing, and
  the next gate refuses `identity_changed`. Binding `status` to the snapshot is left to S-14, which
  derives the status advisory.
- A proof command that adds `url.<other bare>.insteadOf <the run's URL>` still reaches SHIP_READY.
  `ls-remote` is given the run's URL but is served by the other repository. `ship_ready.base` stays
  the freeze sha, so the other repository's head is not adopted.
- A same-user rewrite of `state.json` together with the URL is not caught.
- Nothing is re-read between two gates, so a change made between gates is caught at the next one.
  Ship-ready, which no gate follows, reads both again after its proof.
- Not in S-28a: enrollment, review freshness, the publication/PR half, and a `status` advisory.
  These belong to S-28b and S-14.

**Lock and persistence.** Every mutating command takes one lock file created
with `O_EXCL` holding `{pid, process_start_time, host, run_id, nonce}`, and
releases it on every exit path. On `lock_held` wait for the holder and retry; never delete the lock file by hand. Only the same host may recover it, and only when
the PID is dead or alive with a different known start time (PID reuse); a live holder
whose start time cannot be read stays `lock_held`. A foreign-host
or malformed lock is refused with a recovery instruction, and concurrent
recovery is decided by an `O_EXCL` recovery marker. A sink that fails (an unwritable log or plan) never fails the
command: the event stays in the outbox, `status.telemetry_degraded` names it, and the
next command or `resume` replays it.

**Launch handshake and quiescence:** details and `retire()` in [harness-internals.md](harness-internals.md).

The launcher keeps at most 32 MiB of
stdout; past it the envelope records `truncated: true` and the full `stdout_bytes` (CodeRabbit
B12, owner decision: flag, do not fail). The attempt's outcome is decided exactly as without the
flag; workers, RED, proof and unit-check runners carry it on their attempt envelope, and
`status`/`eval` list them as `truncated_outputs` (`{attempt_id, kind, node, stdout_bytes}`). The state commit refuses (`unquiesced_exit`) to persist a terminal attempt that did not pass through it;
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
dispatches alike). RUN-STATE readers split lines on every break a common reader honours (list: [harness-internals.md](harness-internals.md)). A block holding one of those (other than `\r\n`), or a
`{` line that is not JSON, is `run_state_malformed`: every mutating command refuses until the
owner normalizes the plan file. So is any marker count other than exactly one BEGIN followed by
exactly one END (a duplicate or stray END, a second BEGIN, a missing END, a marker inside an
event's JSON); the carrier's `verifyApproval` refuses the same blocks. The refusal says how to repair the block: in a separate edit, deleting a non-JSON `{` line
rather than editing it into JSON, then re-appending any owner event as a new, distinct line once
nothing is live. `RETRY`, `UNIT_CLEAR` and `DAG_BOUND` authority stays the orchestrator's RUN-STATE write,
as without the engine, and the engine honours an authority line only from
`state.authority.trusted` (`engine-authority.mjs`). At the start and end of every locked
command it classifies each new `START`/`DAG_BOUND`/`RETRY`/`UNIT_CLEAR` line: trusted only when no attempt
(worker, RED runner or proof runner) was started since its last quiescent observation,
otherwise `untrusted` (listed in `status.authority_untrusted`). Any dispatched code (a worker,
a RED spec, a proof command) that appends one is therefore never honoured; an owner line
appended while something dispatched is live is also untrusted, and the owner re-appends a
distinct line (for example with a timestamp) once `status` shows nothing live. When git cannot produce a snapshot
the result is `ownership_unavailable`, never clean.

**Staleness.** A completed node stores fingerprints of its declared reads and
writes (existence, type, mode, content hash; never mtime). On `drive` or
`resume`, a changed input or output marks the node and its dependency closure
`stale`; stale nodes re-run automatically only before the REVIEW freeze.

**REVIEW freeze versus finding-bound REPAIR.** After the freeze (`gate review`
records the frozen candidate), drift is a judgment point (`post_freeze_drift`).
`gate ship-ready` refuses with it too (exit 2, a judgment point) while any done node's declared
input or output differs from the fingerprints it was built with, including an input edited after
the last `drive` and before the final review froze the candidate (AIS-HARNESS-3 Wave 3.5).
Recovery from `post_freeze_drift` (the reason text is unchanged): revert the drifted path to the
bytes the node was built with, and the judgment clears on the next command. When the drift came
after the freeze, the work tree is then the frozen candidate again and the run continues. When it
came before the final review (the review froze the drifted tree), the reverted tree is no longer
the reviewed candidate, so ship-ready refuses `candidate_mismatch`: the owner appends a RUN-STATE
`RETRY` and a new original final review is recorded on the reverted tree. A final review FAIL does
not recover it by itself: while the judgment stands `drive` dispatches nothing, the repair included.
**Before removing the ticket worktree: `archive`.** For a legacy run (before S1, or under the escape hatch) the state
file, engine log and usage ledger live in the work tree's own git dir, so `git worktree remove` deletes them (TICKET-A
lost its token and timing data that way; a durable run's files are in the common dir and survive it). Run `run-engine.mjs archive` first: it copies them with a `manifest.json`
(sha256 per file) to `<git common dir>/ai-skills/ship-ticket/archive/<ticket>/<run-id>-<n>/`, never
overwriting an earlier archive. It is owner-invoked, takes the lock but changes nothing in engine state, refuses another run's id (`run_mismatch`), and does not copy
`.attempts/` (envelopes and outputs) of a legacy run; for a durable run it also copies `attempts/` to
`<archive>/outputs/attempts/` with an `outputs.json` sha256 list (`manifest.json` is unchanged), and `--retire true` moves the
live `attempts/` into `<archive>/retired/attempts/` before any engine file. Retention: these copies include every worker's
raw stdout (`.out`), which may contain secrets; they stay under the git common dir (never committed) until removed by hand,
like the rest of the archive. `usage.jsonl` is copied as it stands: run `archive` when nothing is dispatching or importing usage,
or its last line may be a partial record (the manifest hashes the copy, not a repaired file).
`archive --retire true` (S-13a) is the one exception to "changes nothing": after the copy it refuses while any attempt is
live or not proven quiescent (`retire_live_attempts`) or when the live bytes differ from the archived copy (`retire_mismatch`),
first finishes the RUN-STATE authority observation of the live state and persists it (a crash after a quiescent commit and
before a command's final observation leaves lines unclassified), copies, writes `<archive>/retired/retire.json` (run, final
seq, state digest, whether an authority record existed), then RENAMES (never deletes) the live engine log, usage ledger and
state, the state last, into `<archive>/retired/`, so a new run of the ticket can `init`. A crash between renames leaves the state live; `archive --retire true` again completes it.

**Run adoption (`adopt`, S-13a, same base).** A new run can take over the still-valid work of an archived run of the same
ticket and approved plan instead of re-dispatching it. Flow: `archive --retire true` the old run; the owner appends a new
`START` of the new run for the same narrative (that START is the approval: `adopt` has no authority of its own); `init` the
new run; `run-engine.mjs adopt --from <archive dir>`; then `drive`. Placement is the adopting run's own property (S1): a pre-S1
or escape-hatch archive (policy 1-12) is adoptable into a default durable run (13-24) and back. `adopt` runs only right after `init` (zero attempts, every
node pending, no RED, freeze, review or earlier adoption: else `adoption_window_closed`, also what a second or concurrent
`adopt` gets) and writes one atomic commit or nothing. The source must be FINAL: the completed `archive --retire true` of its
run (retire record and retired state present) holding that run's latest state; an earlier or plain `archive`, a retire that
crashed before renaming the state, or an archive superseded by a later state of the run is `adopt_source_not_final`. A copy of
the archived state is observed against the current plan before any check, so a line that appeared while its work could run is
untrusted even when its own observation never finished; a source without a complete observation is
`adopt_source_unobserved`. Whole refusals (exit 1, nothing written): `--from` not a run archive directly under `<git common dir>/ai-skills/ship-ticket/archive/<ticket>/` after resolving symlinks (`adopt_source_outside`); a
manifest or file that does not verify (`adopt_archive_invalid`); a live or unretired archived attempt (`adopt_source_live`); a
different plan digest (`adopt_plan_mismatch`: cross-plan adoption is refused); policy semantics that differ other than the
pinned base and the repository identity flag (`adopt_policy_mismatch`); under `config.repoIdentity`, an archived run whose
`S.base` names another repository than this run's (`adopt_identity_mismatch`, R14; an archive naming none is adopted, and a
flag-off run never gets this refusal). Adoption never touches `S.base`, the `IDENTITY_BOUND` note or a freeze base, so every
later identity check of the adopting run is unchanged; units on either side (`adopt_units_unsupported`); a latched security REAPPROVAL (`adopt_reapproval_pending`); an
outstanding archived judgment as `status` would compute it: stored judgments, failed nodes and repairs, refused RED re-runs and
security judgments (`adopt_source_judged`); a RUN-STATE line this run trusts that the archived run saw appear while
its work could run (`adopt_authority_untrusted`). The binding of the new run (narrative, START and DAG bytes) is re-verified
first, as by every mutating command. Per node, an archived `done` node is
adopted only when its definition (id, deps, reads, writes, othersOwned, resources, redSpecs, evidence, phase, role, risk,
modelTier, promptFile path, acceptance, checks; not complexity or estimatedMemoryMb, which only schedule) is unchanged (`node_scope_changed`), its read and write fingerprints equal the work tree
(`node_files_changed`) and every dependency is adopted (`dep_not_adopted`: a changed node invalidates every dependent). A
RED-bearing node also needs its archived RED evidence to bind the new run's specs and runner and to be unchanged by the
engine's own RED-validity check (same spec bytes, same base); the evidence is then carried verbatim. Otherwise the node is not
adopted and the run stops on the judgment `adopt_red_unverified` (or `adopt_red_missing`; exit 2): re-running RED after the
dependents' implementation is in the tree would only report `spec_not_failing`. A moved base always gives
`adopt_red_unverified` in this slice. No command clears it in that run, and a second `adopt` is always
`adoption_window_closed`: the clearing path is a fresh run (`archive --retire true`, a new START, `init`), adopted after the
archived bytes are restored, or not adopted at all. Adopted nodes carry `adopted: { run_id, archive, manifest_sha256 }`; one `ADOPTED`
engine note lists the adopted and rejected nodes (no RUN-STATE line). The archived builder roster (every builder, repairs
included, and through a chained adoption) is carried, so an original builder is still `reviewer_is_builder` at the final review. Review records, the freeze, repairs, security state,
test-kinds records, unit evidence and usage rows are never adopted; the archived usage stays in its archive.

**Plan roots are not node writes.** A node whose `writes` or `othersOwned` sit under `.specs/` or
`.spec/` is `dag_invalid` at `init` (the carrier always refused such a worker, as a `node_failed` at
dispatch). Evidence files under `.specs/` (a VAPT ledger, a review record) are written by the
orchestrator, not by a node.

**Accepting a deliberate hand edit (`rebind`).** When the edit was intended (a typecheck fix, a
secret-scan marker) and was made before the review froze the candidate, `run-engine.mjs rebind
--reason <text>` re-binds the drifted done nodes' fingerprints to the work tree and appends a
`REBIND` event (the reason, the candidate and each node's path deltas) to RUN-STATE. It is refused
unless the work tree is exactly the frozen candidate (`rebind_not_frozen_tree`: the review saw
these bytes; an edit after the freeze must be reverted or sent to a new review with a RETRY),
and also with no freeze (`rebind_no_freeze`: before the freeze a drifted node re-runs as stale),
a drifted path the candidate does not cover (`rebind_uncovered`: e.g. an excluded file such as `session-log.md`, which no review saw), nothing drifted (`rebind_nothing_drifted`) or live attempts (`rebind_attempts_live`). It never moves the freeze or relaxes the drift
check. A changed RED spec still needs `gate red`. Known limit: a node that declares a directory (not files) whose contents changed is refused as `rebind_uncovered`, because coverage is exact path equality and the candidate lists files; this fails closed. Declare files, not directories, for nodes the owner may need to rebind. If a crash follows the commit, the next command delivers the `REBIND` event once, and a repeated `rebind` then answers `rebind_nothing_drifted`: the first call already took effect. **Routine in-scope correction before the freeze is the Factory's.** When a gate refuses a completed
node's output for a fixable reason inside the approved scope (for example a test name that does not equal
the bound `<boundary>:<control>`), the Factory fixes it itself: edit only inside that node's owned paths, put
the correction into the node's brief too (a drifted done node re-runs as stale, and the worker could otherwise
reproduce the defect), and re-run the gate. No owner round trip, no weakened assertion, no waived gate. The
orchestrator's model must differ from the primary and second-opinion reviewers, and the normal review chain
covers the edit. Anything larger is re-dispatched as a worker. After the freeze, a deliberate hand edit is
accepted only through `rebind` as above, and the review covers it because the frozen candidate includes it.
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

**Round counters.** PROVE correction follows the corrective-iteration rule in `SKILL.md` "Bounded repair"
(instructions, not engine checks): strictly fewer failures or a failure set not seen before counts as progress,
two consecutive rounds without progress or a backstop of 6 corrective rounds per ticket stop it, and the
ticket's `config.budget` is mandatory for any run that uses this path. The Factory makes routine corrections
as an edit plus a gate re-run. Before EACH correction round (an orchestrator direct edit or a gate re-run included) the orchestrator imports the usage so far with the existing usage tooling (`usage.mjs import-session` / `import-codex`) and checks the `config.budget` headroom; no headroom, or usage that is unknown or cannot be imported, stops to the owner, never a proceed-on-unknown. `config.budget` is set in the plan template's Budget line BEFORE approval, for every plan (single tickets included), so no later plan edit or re-approval is needed to get a correction budget; a plan without one has no Factory-owned correction, and the ticket returns to the owner at the first failure. The engine keeps a backstop counter `rounds.prove_repair_batches` (cap 2) for a
`prove`-kind repair item; no production path enqueues one today, so it never limits routine correction. REVIEW
keeps one repair and one confirmation per review execution (`rounds.review_repairs[<review_execution>]`).
Beyond them, or after a terminal failure, is `round_limit`: a new original review needs a RUN-STATE `RETRY`,
which the Factory writes under the same progress rule (`authorized_by` `factory:bounded-retry`, never the
owner's name) when the cause is a review FAIL that stays inside the approved scope. Each new original review
spends one second-reviewer run of the cap. A counter moves only when the dispatch is actually
launched, never on a refused one; an automatic infra retry of a review repair re-dispatches
within the round it already holds. Counters are never reset.

**Who takes a judgment point.** One table, so no code is guessed. "Factory" means the orchestrator resolves
it inside the approved scope under the corrective-iteration rule in `SKILL.md` "Bounded repair"; "Owner"
means the ticket parks (only it and its genuine dependents) and the owner decides. The table governs: several
engine messages and `status` stop kinds (`candidate_moved`, `confirmation_fail`, `review_fail_no_repair`,
`review_terminal`, `rebind_*`) still say "owner RETRY" because they predate this change. A code the table does
not list goes to the OWNER (fail closed).

| Judgment code | Goes to | Why |
|---|---|---|
| `crash_with_writes`, `quiescence_unknown`, `ownership_unavailable`, `candidate_unavailable`, `repair_failed`, `red_required`, `red_invalidated`, `dispatched_before_red`, unsupported RED runner output | Factory | a routine execution or gate failure; fix or re-dispatch inside the approved paths and re-run |
| `ownership_violation`, `repair_outside_findings` | Owner | both come from the same outside-the-approved-write-set check; any write outside the approved set is owner-reserved (`SKILL.md` "When execution may yield"), and the owner decides whether it is accepted or reverted |
| `confirmation_fail`, `review_fail_no_repair`, `candidate_moved`, `round_limit` | Factory | a bounded new review: write the root-cause assessment, then a `RETRY` recorded `factory:bounded-retry` under the progress rule. The owner when the FAIL carries a security finding on any ticket tier, when the candidate moved because of post-freeze drift or a moved base, or when the plan must change. A failed security review stays with the owner regardless of the ELEVATED tier |
| `review_terminal` (an overflow FAIL) | Owner | matches the engine's own classification |
| `stale_candidate` and `post_freeze_drift`, `repair_unauthorized` | Owner | the frozen candidate and its authorization are a gate-safety boundary |
| `run_mismatch`, `approval_mismatch`, `dag_mismatch` | Owner | the approved plan or DAG changed, which is a material change |
| `budget_stop` | Owner | the approved budget is spent |
| unit codes `unit_review_terminal`, `parent_ceiling`, `unit_check_failed`, `unit_invalidation_storm` | Owner | units are opt-in; a unit's RETRY and its clear (`UNIT_CLEAR`) stay with the owner ([units.md](units.md)) |
| any security refusal or waiver ([security-risk.md](security-risk.md)) | Owner | security exceptions are never Factory-owned |

**`mark`** accepts only `failed->pending` (counts as a retry, capped at 1) and
`pending->cancelled`, with a reason. It cannot mark nodes done, create gate
evidence, change ownership, enable API billing or reset a counter; any other
transition or extra key is `mark_refused`. `failed->pending` clears the node's judgments
and every **spent** judgment: a `quiescence_unknown` whose every attempt has since been retired
(its group proven gone), such as a RED or proof runner's. `resume` clears
spent judgments the same way and records them on its RESUME event, so a spent runner judgment on
a run with no failed node is not a dead end. The retry cap is unchanged.

**Judgment points** (`status.judgments[].code`) stop the engine and go back to
the orchestrator or user: `run_mismatch`, `approval_mismatch`, `dag_mismatch`,
`crash_with_writes`, `quiescence_unknown` (always on Windows, where descendants
can outlive the leader: known limit N7 below),
`ownership_violation`, `ownership_unavailable`, `post_freeze_drift`,
`repair_outside_findings`, `repair_unauthorized`, `round_limit`, `budget_stop`,
`red_invalidated`, `red_required`, `candidate_unavailable` and `repair_failed` (computed: a final-review
repair that failed; it is terminal for its review execution, and a RETRY of that review (see the table below for whose)
cancels it as `superseded by retry`). The gate adds
unsupported RED runner output, `dispatched_before_red` and a terminal overflow FAIL
(`review_terminal`) (all returned with `judgment_point: true`; the CLI exits 2).

**Budgets.** `config.budget` holds dispatch thresholds: a warning at 80%, and at
100% no new dispatch (`budget_stop`, a judgment point). Before every node **and
repair** dispatch the engine re-reads its own records plus `<TICKET>.usage.jsonl`,
deduplicated by `source_execution_id`, and evaluates `phase_tokens` with the
dispatching item's phase. Work in flight can overshoot, and that is reported.
Unknown usage (including a malformed import line, and an attempt that ran but settled without an
envelope: a timeout or a crash) sets the `budget_unenforceable`
flag rather than counting as within budget; the engine does not stop on it.
`status.budget` shows the ticket and phase state (`ok|warn|stop_dispatch|unknown`)
and the flags, plus `phase_unknown` (`{records, tokens}`) when imported usage carries no phase. Budgets never change review or model policy.

## Gate verifier

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
  reaches disk. Runners (RED, proof and unit checks) run repository commands with the engine's
  own, unmodified environment, API keys included: the billing strip above applies to provider
  workers only. Runner adapters (`parseRunnerOutput`):
  `node --test` TAP (including nested subtests), vitest JSON, jest JSON. RED needs
  every named spec to report an **assertion** failure; import, compile and
  collection errors do not count. A runner that rewrites a named
  spec file (a snapshot update) is refused as `spec_rewritten`: the spec digests are taken before
  the runner starts. Unsupported output cannot establish RED: that
  is a judgment point and the manual flow applies, marked degraded (on an ELEVATED or security-sensitive run
  that is **WAIT_FOR_USER** at fallback time, SKILL.md stop list). Evidence is
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
  second opinion must differ (`reviewers_not_distinct`, also when they share
  `<provider>:<model>` and differ only in a suffix). It tracks the original →
  repair → confirmation chain by `review_execution`. Counts or a route name alone
  are never accepted. An accepted non-overflow FAIL with at least one finding to fix returns the
  finding-bound `repair` write set; any other accepted FAIL returns none.
  Through `run-engine.mjs gate review`, the reviewed candidate is the frozen one: a
  new original review after any earlier original (a FAIL or the freeze) needs a
  RUN-STATE `{event: "RETRY", run_id, review_execution, predecessor, authorized_by}`
  naming the previous execution and trusted by the engine (`retry_unauthorized`
  otherwise; a fresh id alone is refused; a matching but untrusted line is a judgment point), and an accepted FAIL that opens a repair needs `repair_prompt_file` (`repair_prompt_missing`).
  `repair_ownership` must be a list of paths (a usage error otherwise). A targeted confirmation
  may carry a `second_opinion` confirmation (`{route, reviewer_identity, candidate_id,
  checked_findings, outcome, evidence}`): when supplied it is validated and counted (the record is
  PASS only when both are), and it is required (`missing_second_opinion`) when the repair's write
  set overlaps a node labelled `concurrency` or `security` (review.md, Targeted confirmation).
  Only an original review records a dispute of a dropped pair (`security_na_disputed` at
  confirmation and ship-ready); a confirmation records none, and a RETRY is not bound to a
  confirmation FAIL (security-risk.md section 13, L2 and L3).
  A repair dispatch is routed like the nodes whose writes it overlaps (their risk labels, and high
  complexity if any is high), so a repair of a risk-labelled node gets the strong tier.

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
  `candidate_mismatch` and its proof is bound to no tree (`local_proof.candidate_id: null`,
  `dropped: ["candidate_mismatch"]`), so a RETRY review of the tree it left still needs a proof of
  that tree; one that changes the approval binding (the excluded plan
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
  the reviewer judges adequacy. `red_accepted` and `exists` are re-derived on every
  `gate ship-ready` (the stored list too, when the input names none) and again after the proof
  ran, as are the graded artifact digests: a git-ignored evidence file or artifact is outside the
  candidate id, so a deleted or regenerated one is seen only this way.

## Eval report

```bash
node <SHIP_TICKET_SKILL>/scripts/eval.mjs report --repo <R> (--ticket <T> | --all) [--usage <usage.jsonl>...]
```

Read-only (`ship-ticket-eval-v1`). Reads the run log, the engine state and usage
files; anything a source does not carry is `unknown`, never zero. Exactly three
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
  --repo <dir> --ticket <key> --run-id <id> --input <json-file>` (and, with `config.earlyChecks`, `gate prove`:
  the pre-review early checks and bounded proof, [prove.md](prove.md)): under the engine
  lock it computes the candidate itself (pinned exclusions), calls `gate.mjs`,
  commits the result and, on ship-ready, appends `SHIP_READY` to RUN-STATE once.
  Exit 0 accepted, 2 refused or judgment point, 1 usage error.
- Real-ticket savings are not measured. The plan's fixture benchmark and an
  `eval.mjs` comparison against the TICKET-F/G/H baseline are still to be run
  on a real ticket; do not quote a saving.
- Windows behavior of the shims is covered by unit tests and the Windows CI job
  with a fake CLI. Real Claude/Codex Windows installs were not exercised.
