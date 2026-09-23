# EVIDENCE — four lanes, one pinned system state, no lane standing in for another

Loaded when EVIDENCE starts. Row outcomes, the manifest, qualified paths and the
integrity check are defined in [state.md](state.md).

## The lanes

| Lane | Proves | Never proves |
|---|---|---|
| **STATIC** | what the pinned source says: structure, rules in force, a control present in the file, a contract both sides agree on, a claim in a doc matching the code | that the code runs, or that a control engages |
| **AUTOMATED** | what the repositories' own commands report on their pinned commits | that an untested journey works; that a test asserts anything useful |
| **FUNCTIONAL** | that a journey behaves as expected on a running local system | that it resists a hostile principal |
| **ADVERSARIAL** | that a control engages, or fails to, under attack on a local system | that code nobody attacked is safe |

**Evidence from one lane cannot fill another lane's row.** A green unit suite does
not pass a `FUNCTIONAL` row. A static "ownership check exists" does not pass an
`ADVERSARIAL` row. A refused attack does not pass the `STATIC` security row. When
a lane cannot run, its rows are `DEGRADED` even if another lane looked at the same
subject. The same holds across components: one service's green suite says
nothing about another service.

## Scheduling

Treat EVIDENCE as a dependency graph. A node is ready when its inputs exist. Two
ready nodes run concurrently when their write paths do not overlap, neither
changes an input the other reads, and they share no exclusive resource: port,
datastore, build output or cache directory, lockfile, browser profile or
generator output. Separate repositories and separate components usually satisfy
all of these, so they run side by side.

The usual graph, derived from the actual commands and topology rather than from
this list:

- **Ready immediately:** every `STATIC` partition in every repository, since all
  are reads of pinned commits; every `AUTOMATED` command with no build
  prerequisite, each in its own repository's worktree; creating the disposable
  datastores.
- **After the build it depends on:** the commands that consume that build output,
  including another repository's build when a component depends on it.
- **After per-component bring-up:** `FUNCTIONAL` journeys that stay inside one
  component. Bring-up means the component boots from documented configuration
  against a disposable datastore with genuinely external third parties stubbed.
  A boot path that migrates or seeds runs only under the recorded stateful
  authority. Without it, the component is not booted and its runtime rows are
  `DEGRADED`. Bring-up is itself evidence for the `O` and `D` rows.
- **After assembly:** contract, integration, end-to-end and cross-system journey
  rows. Assembly means the orchestration root brings every participating
  component up together from its pinned worktree. These rows depend on the pins
  of all their components and on that assembled topology. They never depend on a
  live checkout, and never on a component version the pin vector does not name.
  Without an orchestration root, assemble from the repositories' documented local
  setup. If that is impossible, the cross-system rows are `DEGRADED`.
- **`ADVERSARIAL`:** on a separate instance or assembly (its own worktrees at the
  same pins, ports and datastores) it runs concurrently with `FUNCTIONAL`. On a
  shared instance it runs after `FUNCTIONAL`, with the datastores reset in
  between, because attack traffic corrupts functional state.

Dispatch every ready node in the same wave. Serialize only for a named
dependency or exclusive resource. Without a concurrency carrier, run the same
graph serially, record a `performance` degradation, and continue. That is
never a reason to stop.

**Runtime resources are owned by recorded ID, never by name pattern.** Every
process, container, port and datastore the audit starts gets a run-unique name
(`pa-<short digest>-…`) and is recorded in the manifest's rules of engagement
with its PID or container ID the moment it starts. Before binding, check the
port is free (`lsof -iTCP:<port> -sTCP:LISTEN`); if it is taken, pick another
and record it — never assume a default port belongs to this run. Stopping means
`kill <recorded PID>`, `docker stop <recorded container>`, or stopping the
harness task that owns it. **Never `pkill -f`, `killall`, or any match on a
command line or image name:** another audit, a developer's dev server, or a
parallel agent on the same repository runs the same `node dist/main.js`, and a
pattern match stops theirs too.

Record each wave as an event with its members. At each join, run the integrity
check from [state.md](state.md) on every worktree used since the last join.

## Independence

Workers inspect the same pinned system state and **never see another worker's
conclusions** before producing their own: not in the prompt, not as "context",
not as a summary written by the orchestrator. Reconciliation is the first and only
place results meet.

A worker packet holds: the run ID, the pins of the repositories it touches and
their worktree paths, the assigned rows (subject, components, qualified paths or
entry points, criticality), the lane's rules from this file, the finding contract
from [reconcile-report.md](reconcile-report.md), the four outcome tokens, its
output directory `evidence/<artifact_key>/` (already containment-checked by the
orchestrator), and its prohibitions: no fixes, no writes
outside its worktrees and output directory, no commits, and no network beyond the
local targets and the declared dependency install.

If no fresh worker or separate process is available, one context performs every
lane and carries its own earlier conclusions. Record an `independence`
degradation and write each lane's evidence to disk before the next lane begins.
Never describe a single-context run as independent review.

## STATIC

Partition by repository, component and specialist so no worker holds more than
it can read in full. Each partition runs in its owning repository's worktree, so
that repository's own instructions and conventions apply to it. **Split, never
truncate.** A worker that reviewed a subset covered nothing on the rest. Compare
each report's reviewed paths and rule rows against the assigned rows; send one
follow-up dispatch for the missing part only; what is still missing is
`DEGRADED`.

Routing follows each component's detected stack, not the system's: a system can
route an Angular front end, a React front end and backends in several languages
to different specialists in the same run. Routed specialists run as an
**explicit audit** of the assigned surface, not as a diff review. Every finding
is pre-existing by nature. They report; they do not fix:

- **Dedicated specialists** (`angular-code-quality`, `backend-code-quality`) run
  their own rule-by-rule Verification Pass over each component partition. There
  is no Design Contract, so the rules in force are every `[NN]` rule, every rule
  whose surface the component contains, and one `AI-FM` row, as those
  specialists define them.
- **The code-quality hub** covers every component with no dedicated specialist
  (for example a React, Vue or Java front end or library). It has no Verification
  Pass, so do not ask it for one. Walk its core as explicit checklist rows: one
  `UNIVERSAL` row (the universal principles), one `AI-FM` row (the AI failure
  modes), and one row per rule in the repository's existing project constitution
  when one exists. Each row carries evidence (a path, a line, a clause) for every
  item walked. A complete checklist with evidence can `PASS`. The hub's guard fix
  step is suppressed, and its setup mode that writes a constitution is not run.
  With the hub and its core absent, direct inspection is `DEGRADED` and cites no
  rule IDs.
- **test-quality** runs in review mode over each component's tests.
- **docs-accuracy** runs in review mode over each `D` surface, verifying claims
  against the pinned source of the repositories they describe.
- **security-audit** runs its audit command only, never its specify, plan,
  tasks, implement or fix commands. Invoke it from the evidenced component or
  repository root in the audit worktree, and only when its method supports that
  layout and stack. The files are on disk, so never enter its chat or paste
  mode, and never ask the user to paste repository files. Its report is copied
  into `evidence/<artifact_key>/` for the logical ID
  `security-audit:<component-id>`. Compare what it read with the assigned paths.
  Surfaces it does not support, or did not reach because of its wave stop, go to
  the direct-inspection fallback in the spine's routing table. They stay
  `DEGRADED`, and are never filled in with guesses.

Architecture, contract, operations, data store, integration and constraint rows
have no specialist. The orchestrator's direct inspection covers them. A contract
row reads the definition on every side, in every repository involved, and a
mismatch cites both anchors. These findings carry no rule ID.

## AUTOMATED

Select each repository's commands from what its CI actually gates first, then from
its scripts, task runner and build files. Run each command **in the repository
that owns it**. Run system-level integration and end-to-end commands from the
orchestration root's worktree. Record each as `CMD-NN` with its repository and
source.

- Run each command in its CI or non-interactive form: never `--fix`, `--write`,
  snapshot update, or any watch mode. Never run a deploy, publish, release or
  push. A test harness that provisions and destroys its own isolated datastore
  runs under repository-check authority, after its configuration is verified. A
  standalone migration or seed runs only under stateful authority, and only
  against a disposable datastore ([scope-inventory.md](scope-inventory.md)).
- Record the exact command, the environment variable names (values redacted),
  exit code, duration and a full log in `evidence/<artifact_key of CMD-NN>/`.
- A command a repository declares but that cannot run here (a missing toolchain,
  a service with no stub, a sibling repository that is not pinned, network
  denied) is `DEGRADED`, naming what is missing. It is not skipped silently and
  not passed.

## FUNCTIONAL

Exercise each `J` journey on the local system as its principal: a browser
automation tool or a repository's end-to-end runner for UI journeys, a direct
HTTP, RPC or message client for API and event journeys. Record expected behavior
(from docs, acceptance tests, UI copy or API contracts, with the source cited),
observed behavior, the components that served each step, and the transcript,
response bodies or screenshots.

- State-changing steps run only under the stateful rules of engagement recorded
  before EVIDENCE began. Without them, walk the read-only part, mark the row
  `DEGRADED`, and name the unexercised steps.
- A UI journey with no browser capability is `DEGRADED`. Checking the API behind
  it is useful evidence, attached to the row as partial coverage, but it does not
  pass the UI journey.
- A journey that crosses a missing, placeholder or unrunnable component is
  `DEGRADED` and names that component. Stubs stand in only for genuinely external
  integrations or units the user placed out of scope. A stub for an in-scope
  missing unit, or for a pinned component, may supply partial evidence but never
  makes the row `PASS`.
- A principal with no fixture or seed makes every row that needs it `DEGRADED`.
  Never use a real account.

## ADVERSARIAL

Run only with the authorization recorded before EVIDENCE began. Invoke **vapt in
AUDIT mode** ([vapt](../../vapt/SKILL.md) attacks a local instance by trust
boundary with multiple principals and records rule-named abuse cases; if it is
absent, use the reduced probe below). Its rules of engagement apply in full.
Inside a project audit its contract is narrowed:

- it runs against the local targets and disposable datastores in the recorded
  rules of engagement, using its own audit worktrees at the same pins, recorded in
  the manifest like every other audit worktree so cleanup reaches them;
- its scope is the `B` rows, in its own risk order. A boundary is attacked where
  it is reachable in the assembled topology, including service-to-service calls;
- it writes abuse tests and `.specs/vapt/` tracking artifacts in the worktree of
  the repository that owns each boundary, but **never commits them**. Those are
  the only expected change classes, and only in its dedicated worktree. At the
  end, classify every changed path: tests and fixtures must be inside the
  repository's evidenced test layout; tracking artifacts must be under
  `.specs/vapt/`; anything else is drift. Stage only the validated test and
  fixture paths as literal arguments after `--`, export their cached binary diff
  as the adoptable patch, and copy the tracking artifacts separately into the
  containment-checked `evidence/<artifact_key>/` for the logical ID
  `adversarial:<repo-id>`. Never use `git add -A`. Then restore that worktree to
  its pin and confirm it is clean before the join. The procedure, and the handling
  of any product or unclassified path, is the vapt exception in
  [state.md](state.md). Adopting those tests into the repositories is remediation;
- its fix step and its CI-enforcement step do not run: findings do not authorize
  fixes;
- its disclosure rule stands. Tell the user privately at once about an
  exploitable path, and never place it in anything public;
- when its own rules stop its sweep, the boundaries it did not reach are
  `DEGRADED` with that cause. The rest of the audit continues.

**Reduced probe when vapt is unavailable but authorized:** against critical
boundaries only, test cross-principal access to owned objects, a missing, expired
or tampered credential, and a low-privilege principal reaching a privileged
operation, both directions (the legitimate owner still succeeds). Record results
without VAPT rule IDs; the rows are `DEGRADED`, naming every omitted attack class.

## Bounds

Nothing in this phase loops.

- **Environmental failure** (port in use, service not ready, missing tool): at
  most one retry, after a recorded environment fix that changes no repository
  byte. Still failing: `DEGRADED`.
- **Deterministic failure:** recorded as evidence and never retried toward green.
- **Nondeterminism:** a command that fails and then passes with nothing changed is
  a confirmed flakiness finding, and its row is `FAIL`.
- **Timeout:** the ceiling declared at INVENTORY ends the node. Its rows are
  `DEGRADED` with the elapsed time.
- **Worker failure** (no result, malformed result, lost carrier): one re-dispatch
  for the missing rows only. A second failure is `DEGRADED`.
- **Integrity-check failure:** handled once per the drift rule in
  [state.md](state.md), for the affected repository only.

**EVIDENCE exits** when every row is `DONE` with an outcome, each outcome has
evidence or a reason, and every worktree passed its last integrity check. Runtime
instances and disposable datastores stay up for RECONCILE's one verification
replay and are stopped, by their recorded IDs only, when RECONCILE exits.
