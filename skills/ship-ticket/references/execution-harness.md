# Execution harness (BUILD, PROVE, SHIP; never PLAN)

Bundled dependency-free Node helpers (Node >= 18) under `ship-ticket/scripts/`,
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
| SHIP | `gate` ship-ready, then `usage.mjs summary` and `eval.mjs report`; after the one commit, `publish` (the only supported push and PR); `docker-lifecycle.mjs cleanup` dry run, then `--apply` for this run's containers |

The hand-run flow (`schedule` → `admit` → `carrier.mjs run`, gates recorded in
the plan's RUN-STATE) is a declared degradation, not a bypass: it is limited to
read-only planning and diagnostics, `carrier.mjs run` refuses a run that is not
enrolled and admitted, and nothing ships except through `publish` (Enrollment and
authorization, below).

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
  `{"tests":[{"cmd","result"}],"red_seen":[],"blockers":[],"needs_outside_ownership":[]}`;
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
`git rev-parse --git-path ai-skills/ship-ticket/<TICKET>.usage.jsonl`: the engine reads
that file before every dispatch.

## Enrollment and authorization

```bash
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs context   --repo <R> --ticket <T> --run-id <ID> --phase understand|plan|build|review|ship
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs enroll    --repo <R> --ticket <T> --run-id <ID>          # right after init; idempotent
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs authorize --repo <R> --ticket <T> --run-id <ID> --stage build|publish|complete
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs publish   --repo <R> --ticket <T> --run-id <ID> [--remote origin] [--base <the bound base only>] [--pr-title <t> --pr-body-file <f> [--draft]]
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs ci        --repo <R> --ticket <T> --run-id <ID> [--pr <n>]   # collect CI of the published head
node <SHIP_TICKET_SKILL>/scripts/git-guard.mjs install|uninstall|status --repo <R> [--pattern <regex>]   # opt-in pre-push hook, this repository only
```

- **Lifecycle**, reported as `lifecycle` by `enroll`, `context` and `authorize`:
  `none` (no state) → `unactivated` (`init`: approved plan and bound DAG) →
  `enrolled` (`enroll`: approval re-verified, skill pinned) → `admitted` (`build`
  context delivered) → `evidence` (an engine `SHIP_READY` that still holds) →
  `publication` (`authorize publish` allows). The records are `enrollment`,
  `contexts` and `published` in the engine state, so `resume` and `archive` keep
  them.
- **Migration.** A state without `enrollment` (a run created before this existed) is
  diagnostic-only until `enroll`. A git install can enroll it even after attempts;
  a copy install that already ran attempts cannot (`enrollment_after_execution`),
  and a skill update that changes the mandatory references or `SKILL.md` stops a
  run with `skill_drift`; in both cases the operator path is a new run (new run
  ID, START, `init`, `enroll`). A pre-change `SHIP_READY` needs `gate ship-ready`
  again (`ship_ready_regate`).
- **Enforced:** `drive` and `carrier.mjs run` need `admitted`; a `gate` needs its
  phase context (`red` build, `review`/`unit-review`/`reassess` review, `ship-ready`
  ship) and otherwise refuses without recording a decision; `publish` needs
  `publication`. `init`, `status`, `resume`, `mark`, `rebind`, `archive` and
  `context` are not gated.
- **The skill pin covers only `references/` (through the manifest) and the
  `SKILL.md` digest.** The engine's scripts run unpinned from disk, and the trust
  anchor is `state.json`, which any process of the same user can write. A git
  install pins the skill commit, and every `context` reads that commit's blobs, so
  a later work-tree edit or commit to the skill changes nothing that is delivered;
  when the target repository is the skill repository itself, a worker can commit
  there before enrollment pins it. A copy install pins the manifest digest, and every
  delivery re-verifies the files: a changed, missing or extra reference or a rebuilt
  manifest is refused (`reference_*`, `manifest_drift`). A run enrolls once, never
  while an attempt may run, and a copy install never after an attempt ran; a skill
  change mid-run needs a new run. `context-manifest.mjs build|verify` maintains
  `references/context-manifest.json`, and CI fails a reference edited without a
  rebuild. This proves verified delivery of exact bytes, not that they were read.
- **`authorize`** is read-only: exit 0 allow, 2 deny with one `authorize: deny <code>`
  line on stderr. `publish` also needs a `SHIP_READY` whose state conditions still
  hold (`ship_ready_superseded`), a clean tree, a branch naming the ticket, the
  candidate recomputed against the merge base recorded with `SHIP_READY`, and a
  RUN-STATE `SHIP_READY` backed by its engine line. The PR base is bound, never
  chosen on the command line: the approved DAG's `config.base` branch, else the
  remote's default branch. A `--base` naming any other ref is `pr_base_unbound` (a
  `--base` at a local ref carrying unreviewed commits would otherwise give the
  reviewed merge base and launder them; a stacked PR binds its parent as
  `config.base`). The bound base must give the merge base recorded with
  `SHIP_READY` (`base_mismatch`: e.g. a reused branch with earlier commits),
  measured from the commit the REMOTE names for the base (`git ls-remote`), never
  from a local ref: a `config.base` branch or `origin/<default>` moved onto
  unreviewed commits is `base_moved_local` (the merge bases from the local ref and
  from the remote commit differ). With a `config.base` branch, `gate review`
  verifies the base and the original's freeze records it (ref, remote, repository
  identity, commit); `gate ship-ready` and `authorize publish` re-verify that record:
  a remote base force-pushed off the reviewed commit is `base_moved_remote`; no
  configured remote, another repository, or a freeze or `SHIP_READY` without the
  record is `base_unverified`; a failed `ls-remote`, a missing remote branch, or a
  remote commit not fetched is `base_remote_unavailable`. A remote base that only
  advanced (the branch does not contain the new commits) is accepted: the merge
  base and the PR's range are the reviewed ones; merging or rebasing onto it moves
  the merge base and needs an owner `RETRY` (re-freeze). Residual: the remote is
  reached through the repository's git config (`insteadOf`/`set-url` can redirect
  it; the recorded URL identity is compared, not the bytes behind it), a push to
  the base branch itself moves it, and `state.json` stays same-user writable. And
  no commit since that merge base may touch a path outside the candidate
  (`history_outside_candidate`: e.g. an extra commit later reverted; paths are
  checked, not bytes: an intermediate commit may hold other bytes of a reviewed
  path). A history listing that fails or overflows is `history_unavailable`, never
  an empty history. An enrollment with no captured repository or branch is
  `enrollment_repo_unknown` / `enrollment_branch_unknown`. The candidate is
  computed against the merge base recorded with the review freeze when
  `config.base` is `HEAD`, so committing the reviewed (or repaired) bytes before
  `gate ship-ready` or before the confirmation keeps the candidate: content, not
  commit metadata, decides. A review with no freshness binding is
  `review_binding_missing`, one that is not engine-dispatched under the strict
  policy `review_provenance_unbound`. A `SHIP_READY`
  recorded before the merge base existed needs `gate ship-ready` again
  (`ship_ready_regate`). Its allow binds head, tree, candidate, branch, base and the
  run's `assurance` (`STRICT` or `RELAXED`). `complete` needs `PUBLISHED` for HEAD,
  CI `PASS` recorded by `ci` for exactly that head (below), evidence that verified
  the branch head (`ci_head_unverified`), and the remote branch still at that head
  now (`ci_remote_moved`, `remote_unavailable`).
- **`ci`** (ENFORCED for `authorize complete`). Under the run lock, after the
  binding and the `ship` context are re-verified, it asks `gh` for the check runs
  of the head `publish` pushed for HEAD. The `gh` it runs is the one `enroll`
  pinned (absolute path and sha256 resolved from that moment's PATH): a stub put
  earlier on PATH later is never run, changed bytes are `gh_drift`
  (`publish --pr-title` uses the same pin). A run enrolled with no `gh` on PATH
  pins one at its first `ci`, only after the published branch is verified at the
  published head (`ci_head_unverified` otherwise; the same pre-pin residual as
  enroll); none on PATH then is `gh_unpinned`. `gh` runs with every `GH_*` and
  `GITHUB_*` variable removed (`GH_REPO`, `GH_HOST`, `GH_CONFIG_DIR`, tokens) and
  the OS account's `HOME`, so it uses the account's stored login (an
  environment-token-only setup fails closed), and every call names the repository
  `publish` recorded in `PUBLISHED` (`repository`: the remote's configured URL,
  before `insteadOf`) explicitly (`repos/<owner>/<repo>/...`, `--hostname`, `-R`).
  A remote that names no GitHub repository is `ci_repo_unknown`; a remote URL
  changed since `publish`, or any check run or PR answer whose html URL is of
  another repository, is `ci_repo_mismatch` (also at `authorize complete`). Not
  removed: proxy and TLS variables (a residual that needs a trusted interception
  certificate). That SHA comes from the `PUBLISHED`
  record, never from the caller. It records `CI_EVIDENCE` `{head_sha, checks[],
  collected_at, state, code, timing, repository}` in the state and the engine log, never in
  RUN-STATE. Exit 0 is `PASS`. Exit 2 is any other state or a refusal. A refusal
  before the provider (`publish_evidence_missing`, the binding and context codes)
  records nothing; one after it (`gh_unpinned`, `gh_drift`, `ci_repo_unknown`,
  `ci_repo_mismatch`, `ci_head_unverified`) is recorded as `UNAVAILABLE` evidence
  with its code, so `next` reports it as the human's `BLOCKED` instead of
  offering `ci` again.
  States:
  - `PASS`: at least one required check, every one `completed` with `success`, on
    that SHA. `skipped` and `neutral` are not success.
  - `PENDING` (`ci_pending`, `ci_no_checks_yet`, `ci_required_pending`).
  - `FAIL` (`ci_failed`).
  - `NO_CHECKS`: zero check runs (`ci_no_checks`) or a required name with none
    (`ci_required_missing`), from a collection made `config.ciNoChecksMinutes`
    (default 5) or more after the push.
  - `STALE`: the PR head is not the published head (`ci_head_moved`), the PR is
    another branch (`ci_pr_mismatch`), or the remote branch read at collection
    (`git ls-remote`, recorded as `remote_head`) is not the head (`ci_remote_moved`).
    A branch that cannot be read is `UNAVAILABLE` `ci_remote_unavailable`.
  - `UNAVAILABLE`: a `gh` failure (`ci_provider_unavailable`) or a page count that
    does not add up (`ci_provider_incomplete`). This is never zero checks.

  Runs of another SHA are ignored. A re-run replaces the earlier run of the same
  check (same app, check suite and name); a same-named run of another app or
  workflow is an independent check. ANY failed check on the SHA (`failure`,
  `cancelled`, `timed_out`, `action_required`, `startup_failure`, `stale`) is
  `FAIL`, required or not. The required set (what must pass) is
  `config.ciRequiredChecks` when the approved DAG names it, else every check run on
  the SHA; a `skipped` or `neutral` check outside it does not block. `authorize
  complete` reads only the latest evidence for the published head. It re-judges
  the recorded checks under the bound config (`ci_evidence_missing`, the
  evidence's own code, `ci_evidence_inconsistent`), and it never calls `gh`.
  `--pr` (else the PR URL `publish` recorded) adds the PR view. `NO_CHECKS`
  carries a DETECTED diagnostic, never part of the verdict: the PR's mergeable and
  merge state, each workflow's `on:` triggers with branch and path filters against
  the files changed since the merge base (a line-based reading, `parsed: false`
  where it cannot tell), and recent runs on the branch. Timing is captured
  separately: `dispatched_at` (the push), `first_check_started_at`,
  `checks_completed_at` and `collected_at`. Limits: legacy commit statuses are not
  read, so status-only CI is `NO_CHECKS` (fail closed). The required set is the
  DAG's, not branch protection's. A `PENDING` check has no deadline. The evidence
  is the engine's state file, which any same-user process can write, and an
  in-process caller can pass its own provider (`ctx.ciProvider`): exact-SHA
  matching does not authenticate evidence (no server attestation in R0-S).
- **`publish`** holds the run lock throughout: it authorizes, authorizes again
  immediately before the push and requires the same binding (`authorization_moved`),
  records the bound PR base for the HEAD it pushes (`publish_intent`; the guard's
  hook re-derives the same bound base and refuses a recorded one that differs),
  pushes `<sha>:refs/heads/<branch>`, checks the remote ref, opens the PR with
  `--base` only when a title and body file are given, and records `PUBLISHED`
  (`published_unrecorded` if that record fails after a successful push). The remote
  can still move after the check, and direct `git push`/`gh` never pass through it.
- **No degraded bypass.** The engine cannot prove a human said anything (START and
  RETRY are orchestrator-appended), so there is no owner-approval override: a
  degradation is **WAIT_FOR_USER**, and the skill does not ship.
- **git-guard is a guardrail, not a boundary.** It blocks `git push` of a branch
  matching the pattern (default `(?:^|/)([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*?-[0-9]+)`) unless `authorize
  publish` allows the pushed sha AND the destination is exactly the authorized branch,
  including pushes wrapped in a script, `sh -c` or `execSync`. The ticket comes from
  the destination first, then from the source (the local branch, or the checked-out
  branch for `HEAD` or its sha): one ticket's commit to another ticket's branch is
  `cross_ticket_push`, to the default branch `push_to_default_branch`, to any other
  name `push_destination_mismatch`. It also guards any branch naming a ticket that has engine state. It
  refuses a hooks directory inside the work tree unless ignored. In a linked worktree
  it installs into the shared hooks directory and judges each push by that work
  tree's engine state. A `git push <url>` is judged as the configured remote with
  that URL (`remote_unconfigured` when none has it and the PR base would be that
  remote's HEAD). The pattern fails closed on look-alikes: `fix/issue-42` and
  `release-2026-11` read as tickets and are refused until you narrow it with
  `--pattern`. A branch naming two tickets is judged by one run only (the first
  with engine state). `--no-verify`, `-c core.hooksPath=...`, the `GIT_CONFIG_*`
  override, unsetting a repository `core.hooksPath`, a commit the guard cannot tie
  to a ticket (not the checked-out HEAD of a ticket branch with engine state: an
  older commit, a detached HEAD, anything before `init`) pushed under a name with no
  ticket, and pushing with `gh` or another clone
  bypass it, as does any process of the same user rewriting the engine state.

## Run engine

```bash
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs init   --repo <R> --ticket <T> --run-id <ID> --dag /abs/dag.json
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs next   --repo <R> --ticket <T> --run-id <ID>   # after every tool or agent return: execute its next_action
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs status --repo <R> --ticket <T> --run-id <ID>   # read-only: the same derivation, nothing collected
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs drive  --repo <R> --ticket <T> --run-id <ID> [--until <node>]
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs resume --repo <R> --ticket <T> --run-id <ID>
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs mark   --repo <R> --ticket <T> --run-id <ID> --node <id> --transition 'failed->pending' --reason <text>
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs mark   --repo <R> --ticket <T> --run-id <ID> --node <id> --transition 'pending->cancelled' --reason <text>
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs rebind --repo <R> --ticket <T> --run-id <ID> --reason <text>   # accept hand edits to done nodes, only when the tree is the frozen candidate
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs archive --repo <R> --ticket <T> --run-id <ID>   # copy state, engine log, usage and a sha256 manifest to the git common dir; run BEFORE `git worktree remove`
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs review-dispatch --repo <R> --ticket <T> --run-id <ID> --role primary|second|confirmation --candidate <id>   # the engine launches the read-only reviewer relay
node <SHIP_TICKET_SKILL>/scripts/run-engine.mjs review-collect  --repo <R> --ticket <T> --run-id <ID>   # record REVIEW_COLLECTED for finished reviewers (next does it too)
```

The engine runs the process (dispatch, retries, staleness, resume) and leaves
judgments to the orchestrator and the user. It adds no policy: approval,
reviewer independence, billing and ownership checks are the carrier's and
`SKILL.md`'s. `drive` exits 2 on a judgment point; any other failure exits 1.

**Files**, all under `git rev-parse --git-path ai-skills/ship-ticket/` and never
committed: `<TICKET>.state.json` (the ledger), `<TICKET>.engine.jsonl` (the
engine's event file), `<TICKET>.lock`, `<TICKET>.attempts/` (per-attempt
envelopes) and `<TICKET>.usage.jsonl` (imported orchestrator/reviewer usage, read by
budgets). The timing log `<TICKET>.jsonl` stays owned by `run-log.mjs`.

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
  node `risk` for `gate ship-ready`), `acceptanceIds`, `unitRecheckCeiling` and `unitReview` (opt-in; [units.md](units.md)), and
  `ciRequiredChecks` (check-run names CI `PASS` requires) and `ciNoChecksMinutes`
  (the `NO_CHECKS` window, 1..120, default 5), both opt-in and never defaulted
  into the DAG; `reviewProvenance` (`engine`, the behaviour when absent: `gate review`
  accepts only engine-dispatched, collected reviews; `unbound`: the owner opts the
  run out, the earlier gate) and `acceptNativeReview` (boolean: the owner accepts a
  native Agent-tool primary or confirmation, labelled `native_unbound`)
  ([review.md](review.md), Engine-dispatched reviewers). These four are
  ASSURANCE settings. Absent, the run is `STRICT`, the default and the enforced
  release policy. A relaxing value is accepted only when it is written into the
  approved plan narrative (what the trusted `START` digest covers; START is
  orchestrator-appended, so the engine verifies placement, not that a human read
  it): the DAG digest is listed on a VISIBLE line of that narrative (binding
  `plan`; a `DAG_BOUND` line never approves a relaxation) AND the narrative
  carries the exact line `ship-ticket-assurance-policy: <the relaxed values as
  sorted-key JSON>` as a visible line of its own, from its first column. Text in
  an HTML comment (an unterminated `<!--` hides the rest) or a code fence is not
  visible. Else `init` refuses `policy_unapproved`, and `next --dag <file>`
  before `init` answers `NEEDS_APPROVAL` (`policy_unapproved`) with the `relaxed`
  values and the `required_line`. Before every command the engine
  re-validates the digest-verified DAG and refuses a state whose config differs
  (`policy_drift` for these keys, `config_drift` for any other: DETECTED, a
  same-user edit of the state file is refused, not prevented). A relaxed run is
  labelled `RELAXED` on `next`, `status` and every `authorize` allow. Billing is
  `subscription`: the engine CLI has no API-billing switch, so every dispatch of a DAG with
  `billing: "api"` is refused (`dispatch refused: api billing requires allowApiBilling`) by design;
  `allowApiBilling` exists only for a library caller the user authorized.
- node: `id`, `deps`, `reads`, `writes`, `othersOwned`, `resources`, `risk`,
  `complexity`, `modelTier`, `estimatedMemoryMb`, `promptFile`,
  `phase` (`BUILD|PROVE|SHIP`; REPAIR is never a node: the engine dispatches repairs from review
  records only, so a REPAIR node is `dag_invalid`), `role` (`builder|repair|evidence`),
  `evidence`, `redSpecs`, and the opt-in `unit`, `acceptance`, `checks` (see [units.md](units.md)).
- `acceptance` and `config.acceptanceIds` are legal on a DAG without units; [units.md](units.md) applies only when a node has `unit`.

**`next` is the supported path** (`engine-next.mjs`). It derives one disposition per
stage from existing records: `APPROVAL`, `ENROLL`, `BUILD`, `REVIEW`, `REPAIR`,
`CONFIRMATION`, `SHIP_READY`, `PUBLISH` and `CI`. Each stage is `READY`,
`RUNNING`, `WAITING`, `BLOCKED`, `NEEDS_APPROVAL`, `COMPLETED` or `FAILED`. It
returns exactly one `next_action` `{stage, action, reason, owner, disposition}`,
taken from the first stage that is not `COMPLETED`. Later stages are `BLOCKED`
`prerequisite_open`. `owner` is `orchestrator` (you run it), `engine` (an engine
command: `drive`, `resume`) or `human` (only the owner continues). Rules:

- Owed work is `READY`: a review or second opinion with no dispatch, the repair,
  the confirmation, `gate ship-ready`, the commit and `publish`. A review stale or
  terminal under the gate's own rules (a new original needs a trusted `RETRY`) is
  `NEEDS_APPROVAL` `owner_retry`. Execute `READY` and `RUNNING`/`WAITING`
  (`wait`) actions, then run `next` again. Stop only when `next` prints
  `stop: true`: `NEEDS_APPROVAL`, `COMPLETED`, `FAILED`, or `BLOCKED` whose `owner`
  is `human` (exit 2 for all but `COMPLETED`). An orchestrator- or engine-owned
  `BLOCKED` (`enroll`, `recover_review`, a refused `gate_review` or
  `gate_ship_ready`, `resolve` of an engine judgment, `collect_ci` after a provider
  failure) exits 0 and is owed work, but only ONCE: the same gate refusal twice in
  a row for the same candidate, a second consecutive `UNAVAILABLE` collection, and
  any refusal the orchestrator cannot correct (an ungated reviewer FAIL, changed
  receipts or outputs, a moved base, a recorded dispatch refusal, `gh_unpinned`,
  `gh_drift`, `ci_repo_*`, `ci_head_unverified`) are the human's (`stop: true`), so
  no refusal is re-offered as the same action forever. Before `init`,
  `next --dag <file>` answers `NEEDS_APPROVAL` for a relaxed policy the plan does
  not approve. ADVISORY: R0-S has no turn-end (Stop hook)
  enforcement, so an orchestrator can still end its turn early; `stop` only says
  when it may.
- Every answer carries `assurance` (`STRICT`, or `RELAXED` with the approved relaxed
  settings and any accepted review that is not engine-dispatched); a relaxed run also
  labels `next_action.assurance: "RELAXED"`. Relaxing is never silent.
- Under the run lock, `next` first collects finished background work with
  `resume`'s own reconcile: a worker whose envelope is on disk is recorded, never
  dispatched again (the launch protocol refuses a second writer), and `collected`
  lists it. `next` itself dispatches nothing. While another engine command holds
  the lock, a `READY` stage is `RUNNING` (`wait`).
- An engine attempt with no envelope is `WAITING` with its attempt id, `identity`,
  `started_at`, `marker` (the envelope path) and `deadline`
  (`config.timeoutMs` + 60 s). Past the deadline it is `BLOCKED`
  `attempt_overdue` (`recover_attempt`: confirm its process group is gone, then
  `resume`). Nothing is killed.
- Review dispatches (default `config.reviewProvenance` `engine`) are the engine's
  own receipts: the latest one per role for the candidate under review. None is
  `READY` `review_dispatch` with `roles` (run `review-dispatch --role <r>
  --candidate <candidate_id>` for each); a reviewer whose envelope is on disk is
  `review_collect` (or the next `next` collects it, once, and lists it in
  `collected`); a missing or failed relay is `BLOCKED` `review_relay_unavailable`
  or `review_dispatch_failed` (owner; never waived); past the relay watchdog plus
  2 min it is `BLOCKED` `review_overdue`. Once every role is collected, the action
  is `gate_review` with `results` (the parsed files to submit). A dispatch that
  never launched is abandoned and owed again. With `reviewProvenance: "unbound"`
  they are, as before, DETECTED telemetry: the `run-log.mjs` `primary_review`,
  `optional_review` and `review_confirmation` starts of the candidate under
  review, the `--carrier-result` path as the marker (`collect_review`), and
  `dispatch_review` while there are no rows. Rows of another candidate are
  ignored. A refused gate after collection is `BLOCKED` with the gate's code.
  Acceptance stays with `gate review`.
- An un-enrolled run is `ENROLL` `BLOCKED` `not_enrolled`
  (`diagnostic: NEEDS_ENROLLMENT`, action `enroll`): nothing advances.
- `PUBLISH` reads `authorize publish` (any deny is `BLOCKED` with its code).
  `CI` derives from the latest `CI_EVIDENCE` of the published head. With none, it
  is `READY` `ci_owed` (`collect_ci`: run `ci`). `PENDING` is `WAITING`
  `collect_ci`: collect again after `poll_after_ms`. A provider failure is
  `BLOCKED` `collect_ci`, `FAIL` is `FAILED`, and `NO_CHECKS` and `STALE` are
  `BLOCKED` for the owner with the diagnostic. It is `COMPLETED` only when
  `authorize complete` allows; any other deny is `BLOCKED` with its code.
- Judgment codes that only a human resolves (approval, authority, budget, billing)
  are `NEEDS_APPROVAL`. Every other code is `BLOCKED`, and a stage no rule decides
  is `BLOCKED` `underived` (fail closed).

`status` prints the compact `ship-ticket-engine-status-v1` view plus `disposition`,
`next_action` and `stages` (read-only and lock-free: it collects nothing),
including
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

**Review freshness (candidate-bound).** Every accepted original and
confirmation, and every repair record, is bound in `state.review_bindings` to its
candidate and the merge base that candidate was computed against. A confirmation
is bound to its repaired candidate's frozen base. The `review_chain` records are
unchanged. The authorizing review (the last chain record, a PASS) is fresh while
the candidate recomputed against that merge base is still its candidate. A commit,
push, fetch, branch rename, excluded-path edit or commit, or a rebase that keeps
base and tree never invalidates it. Any change to the candidate bytes does:
`review_stale` (same base: an edit, an amend of content) or `review_base_moved` (a
`config.base` branch merged or rebased in; with `config.base` HEAD only
`review_stale` is reported). **Enforced:** `gate ship-ready` refuses to record
`SHIP_READY`; `gate review` refuses a confirmation whose base branch moved since
the repair; `authorize publish` (and so `publish` and the guard) refuses with
the same code. All three hold until an accepted review of the current candidate
exists: the repair's one targeted confirmation, or an original after an owner
`RETRY`. **Detected:** `next`/`status` report `review_freshness`. A stale review
is `NEEDS_APPROVAL` `owner_retry`, because the gate accepts a new original only
after a trusted `RETRY`, and the `RETRY` then makes the new review `READY`. A
review file that only names the current candidate id is no longer enough: the
gate needs the engine's receipt and collection for that candidate
(`review_unbound`, `review_receipt_candidate`; [review.md](review.md),
Engine-dispatched reviewers), unless the owner set `reviewProvenance: "unbound"`.

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
**Before removing the ticket worktree: `archive`.** The state file, engine log and usage ledger live
in the work tree's own git dir, so `git worktree remove` deletes them (SCRUM-307 lost its token and
timing data that way). Run `run-engine.mjs archive` first: it copies them with a `manifest.json`
(sha256 per file) to `<git common dir>/ai-skills/ship-ticket/archive/<ticket>/<run-id>-<n>/`, never
overwriting an earlier archive. It is owner-invoked, takes the lock but changes nothing in engine state, refuses another run's id (`run_mismatch`), and does not copy
`.attempts/` (envelopes and outputs). `usage.jsonl` is copied as it stands: run `archive` when nothing is dispatching or importing usage,
or its last line may be a partial record (the manifest hashes the copy, not a repaired file).

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
check. A changed RED spec still needs `gate red`. Known limit: a node that declares a directory (not files) whose contents changed is refused as `rebind_uncovered`, because coverage is exact path equality and the candidate lists files; this fails closed. Declare files, not directories, for nodes the owner may need to rebind. If a crash follows the commit, the next command delivers the `REBIND` event once, and a repeated `rebind` then answers `rebind_nothing_drifted`: the first call already took effect. Hand edits remain the owner's responsibility:
the review already covers them because the frozen candidate includes them.
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
authorized review execution (`rounds.review_repairs[<review_execution>]`).
Beyond them, or after a terminal failure, is `round_limit`: it needs an
explicitly authorized retry. A counter moves only when the dispatch is actually
launched, never on a refused one; an automatic infra retry of a review repair re-dispatches
within the round it already holds. Counters are never reset.

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
repair that failed; it is terminal for its review execution, and an owner RETRY of that review
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
  second opinion must differ (`reviewers_not_distinct`, also when they share
  `<provider>:<model>` and differ only in a suffix). It tracks the original →
  repair → confirmation chain by `review_execution`. Counts or a route name alone
  are never accepted. An accepted FAIL returns the finding-bound `repair` write set.
  Through `run-engine.mjs gate review`, the reviewed candidate is the frozen one: a
  new original review after any earlier original (a FAIL or the freeze) needs a
  RUN-STATE `{event: "RETRY", run_id, review_execution, predecessor, authorized_by}`
  naming the previous execution and trusted by the engine (`retry_unauthorized`
  otherwise; a fresh id alone is refused; a matching but untrusted line is a judgment point), and an accepted FAIL needs `repair_prompt_file` (`repair_prompt_missing`).
  `repair_ownership` must be a list of paths (a usage error otherwise). A targeted confirmation
  may carry a `second_opinion` confirmation (`{route, reviewer_identity, candidate_id,
  checked_findings, outcome, evidence}`): when supplied it is validated and counted (the record is
  PASS only when both are), and it is required (`missing_second_opinion`) when the repair's write
  set overlaps a node labelled `concurrency` or `security` (review.md, Targeted confirmation).
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
  --repo <dir> --ticket <key> --run-id <id> --input <json-file>`: under the engine
  lock it computes the candidate itself (pinned exclusions), calls `gate.mjs`,
  commits the result and, on ship-ready, appends `SHIP_READY` to RUN-STATE once.
  Exit 0 accepted, 2 refused or judgment point, 1 usage error.
- Real-ticket savings are not measured. The plan's fixture benchmark and an
  `eval.mjs` comparison against the SCRUM-140/96/393 baseline are still to be run
  on a real ticket; do not quote a saving.
- Windows behavior of the shims is covered by unit tests and the Windows CI job
  with a fake CLI. Real Claude/Codex Windows installs were not exercised.
