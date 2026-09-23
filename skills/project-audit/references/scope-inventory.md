# SCOPE and INVENTORY — authority, topology, pinned system state, coverage matrix

Loaded at SCOPE and kept through INVENTORY. The manifest fields named here are
defined in [state.md](state.md).

## SCOPE

### Pre-run preflight: repository set and audit root

The system under audit may be one repository (a single deployable, a modular
monolith or a monorepo) or several locally checked-out repositories that make up
one system (microservices, a separate front end and backend, shared libraries).
Front end only, backend only and full stack are all ordinary cases.

This preflight runs **before the run exists**. It reads the live checkouts only
to decide the set, and writes nothing. No run ID, pin or manifest exists yet.
Determine the **repository set**:

1. **Start from the user's scope:** the repository they invoked in, and any paths
   or repositories they named. Nothing outside that selection is claimed on the
   strength of being nearby. Never walk sibling or parent directories looking for
   repositories.
2. **Extend only on evidence inside that scope:** workspace and multi-module
   manifests, orchestration and deployment configuration (compose files,
   manifests, charts, a service catalogue), a meta-repository or workspace file
   that lists member checkouts, submodules, and relative paths in those files that
   point at other local checkouts. A reference counts only when it resolves to a
   local Git repository.
3. **Never clone or fetch** a repository because configuration references it. A
   referenced repository with no local checkout is recorded: in
   `scope.out_of_scope` when the user's scope excludes it; otherwise as an
   **in-scope missing unit**, which INVENTORY models as a placeholder component
   (below).
4. **Pick the audit root** — the one repository that holds
   `.specs/project-audit/<run-id>/`. For a single repository or a monorepo, it is
   that repository. For several repositories, it is the one the user names, or
   the one that clearly holds the system's workspace or orchestration
   configuration. Record the **orchestration root** too: the repository whose
   configuration assembles the local topology. It is often the same repository,
   and it may be none.

**One scope question, at most.** Ask it only when the requested system spans
repositories and the local set is ambiguous or incomplete, or no audit root is
unambiguous. Bundle everything into that one question: the repositories found
and the evidence for each, the ones referenced but absent, and the proposed
audit root. That is `WAIT_FOR_USER`. Otherwise do not ask.

This wait is **not durably recorded**. There is no manifest to hold it, and
nothing is written anywhere. When the user answers, restart SCOPE from the
resolved set. The run, its manifest and the manifest-only resume contract begin
at the pin step below, not before.

The user may narrow the target ("only the API", "the customer portal"). Record
what was excluded and why in `scope.out_of_scope`. A narrowed audit reports only
on its scope and never implies coverage of the rest.

### Authority and rules of engagement

Invoking the skill grants the first two classes. The others need the user's
explicit words, quoted in `authority.granted_by`. Never infer them from "full
audit" or "be thorough".

| Class | Includes | Needs |
|---|---|---|
| **Static** | reading the pinned system state | invocation |
| **Repository checks** | each repository's own build, lint, typecheck, test and docs commands in their CI/non-interactive form, inside its audit worktree; a dependency audit per package ecosystem, as declared or, when none is declared, the ecosystem's read-only lockfile audit (see the `C` row of the matrix); the lockfile-frozen dependency install those commands need; a repository-native test harness that creates and destroys its own isolated ephemeral datastore | invocation. Never write flags, deploys, publishes or pushes. Never standalone migrations, seeds, or a boot path that mutates a datastore. A self-provisioning harness qualifies only after its configuration has been checked to show it creates the datastore it uses and cannot reach a developer or shared one |
| **Local runtime, read-only** | booting the units locally, alone or assembled, against disposable datastores, and exercising journeys that change no state, where no boot path migrates or seeds | invocation, a safe target, disposable datastores |
| **Stateful runtime** | journeys that create, change or delete data; standalone migration and seed checks; booting a unit that auto-migrates or seeds on start; any mutation of a separately provisioned disposable datastore | explicit rules of engagement naming the targets and datastores |
| **Adversarial** | attack classes through `vapt` AUDIT | explicit authorization plus vapt's own rules of engagement |

A **safe target** is a local or disposable instance the user controls. Never
production, never shared staging, never a third-party host — including a vendor's
sandbox or test mode. Outbound calls to external services run only against the
repositories' own stubs, fakes or local emulators. A unit the user placed out of
scope is external too. An in-scope unit that could not be pinned is not external:
it is a missing unit (see INVENTORY). A developer's local environment file is
never copied into an audit worktree unless the user confirms every host it names
is local or disposable; derive runtime configuration from the repositories'
example or test configuration instead.

A **disposable datastore** is created for this run (an ephemeral container, an
in-memory engine, a fresh local database from a repository's seed or fixture
mechanism) and can be destroyed without loss. A developer's existing local
database is not disposable. A pre-provisioned test database qualifies only when
the user confirms it is isolated for this run and disposable. Otherwise it is not
a disposable datastore.

At SCOPE, record only what the request itself grants or declines. Whether
runtime is feasible, and which targets, datastores and stubs exist, is
discovered in INVENTORY; the one authority question, if needed, is asked there.

### Pin the system state

For **each** repository in the set:

1. Confirm it is a Git repository with at least one commit. If a repository has
   none, it has nothing to pin. If it is the only repository, tell the user and
   end `INCOMPLETE`. Otherwise it becomes an in-scope missing unit.
2. Record its **identity**, **display name** and **repository ID** exactly as
   [state.md](state.md) derives them. The identity comes from the `origin` URL
   with every credential, query and fragment stripped, or else from the path
   relative to the audit root. The ID is a path-safe slug such as
   `orders-service`. Record its local path, the ref and the commit
   (`git -C <repo> rev-parse HEAD`).
3. List its uncommitted state once:
   `git -C <repo> status --porcelain=v1 --untracked-files=all`. Record every
   listed path under that repository's `excluded_uncommitted`. The audit covers
   commits, not working trees. If the user wants uncommitted work audited, they
   commit it (to any branch) and the run pins that commit. The audit never
   commits, stashes or resets for them.
4. Create its detached audit worktree at the pinned commit:
   `git -C <repo> worktree add --detach <audit-dir>/<layout path> <commit>`.
   `<audit-dir>` is one temporary directory for the run, outside every repository.
   `<layout path>` mirrors each repository's path relative to the repositories'
   common parent, so relative references in workspace or orchestration
   configuration resolve to the pinned worktrees, never to the live checkouts. It
   is built from the checkouts' own directory names, never from a remote,
   manifest entry or other repository metadata. The full destination must pass
   the containment check in [state.md](state.md) before `worktree add` runs.
   Initialise submodules at the commits the superproject pins, using only objects
   already present locally. A submodule that would need a network fetch, or that
   cannot be materialised, is an in-scope missing unit and gets a placeholder
   component in INVENTORY.

Then compute the **system digest**: sort the lines `<identity> <commit>`, one per
pinned repository and always using the sanitized identity, and hash them with
`git hash-object --stdin`. The pin vector and this digest together are the
**pinned system state**. A single-repository
audit is the one-line case. The run ID derives from the digest
([state.md](state.md)). Create the run directory in the audit root's checkout and
write the manifest with `phase: SCOPE`.

**Other live runs.** Before creating the run directory, list every manifest
under `.specs/project-audit/` in the audit root whose `status` is `IN_PROGRESS`
or `WAITING_FOR_USER`, and every `git worktree list` entry outside the live
checkout. Another session or agent (a second model auditing the same repository
is a normal case) may own them. Record each as a `concurrent_run` event with its
run ID. Their worktrees, ports, containers and processes are off-limits: never
reuse, stop or clean them up, and choose this run's ports and container names so
they cannot collide (see [evidence.md](evidence.md), runtime resources). A
concurrent run is not an earlier run: its finding IDs are not reused, and its
evidence is never read before this run's RECONCILE, to keep this run
independent.

Every lane reads and runs from the audit worktrees, never from a live checkout.
Specialist skills that write their own artifacts therefore write into disposable
space, and those artifacts are copied into `evidence/<artifact_key>/`. Cleanup
removes only the worktrees this run created and recorded, after each path passes
the containment check (`git -C <repo> worktree remove --force <path>`), when the
run ends, including on `INCOMPLETE`. Keep them only across
`WAIT_FOR_USER`. Never prune or touch other worktree entries. A removal that fails
is recorded as `cleanup_debt` with the exact repository and path.

**SCOPE exits** when the repository set, audit root and orchestration root are
recorded with their evidence, the in-scope missing units are recorded, the
authority classes granted or declined by the request are recorded (quoted),
every pinnable repository is pinned with its worktree, the system digest is
recorded, and the manifest is written.

## INVENTORY

Build the system model from the pinned worktrees. **Derive, never assume**:
languages, frameworks, runners, file layout, migration mechanisms, deployment
platforms, i18n and every command come from what the repositories actually
contain. Framework names are examples of what detection may find, never
requirements.

### Sources

Read in each audit worktree: agent and contributor instructions (`AGENTS.md`,
`CLAUDE.md`, contributing guides), package and build manifests and lockfiles,
workspace and multi-module definitions, task runners, CI workflow definitions,
container, orchestration, infrastructure and deployment configuration, service
catalogues, example environment files, route and handler registrations, API,
event and message schemas, generated clients, UI entry points and route tables,
schema and migration directories, seed and fixture mechanisms, test directories
and runner configuration, documentation and decision records, and logging,
metrics and health-check configuration.

Every element in `inventory.md` cites a **qualified anchor**:
`<repo-id>:<repo-relative path>[:<line or key>]`. Every path anywhere in the
audit carries its repository ID. That holds in the single-repository case too,
so identical relative paths in different repositories never collide. An element
with no source is a guess; leave it out or mark it unresolved.

### Model elements

| ID | Element | Record |
|---|---|---|
| `<repo-id>` | Repository | display name, secret-free identity, local path, pin, worktree, whether it is the audit root or orchestration root |
| `<repo-id>/<name>` (`C`) | Component — a service, module, front end, library or deployable unit, owned by exactly one repository | owning repository, path set, detected language and framework, build and runtime dependencies (other components, shared libraries), entry points, data it owns, deploy unit and how it is orchestrated, its commands, routed specialist |
| `X` | Contract — an API, RPC, event or message schema, generated client, shared library interface or shared database schema that crosses components | kind, provider, consumers, definition anchors on every side, versioning |
| `J` | User journey — an end-to-end task a principal performs | principal, entry point, steps, every participating component and data store, where the steps come from (routes, screens, API docs, README, existing end-to-end tests) |
| `P` | Principal or role — anonymous, each user type and role, tenant, service account, operator | how each component recognises it; whether a fixture or seed can produce it |
| `S` | Data store — database, cache, queue, object store, search index | owning component, other components that read or write it, schema/migration mechanism, tenancy model |
| `I` | External integration — payment, email, identity provider, storage, third-party API, webhook, or a unit the user placed out of scope | direction, credential handling, whether a stub or emulator ships |
| `B` | Trust boundary — where untrusted input or identity crosses into a component, including service-to-service calls | kind, owning component, entry points, principals involved |
| `O` | Operations and deployment — CI pipelines, build/package, containers, orchestration, infrastructure, configuration and secret wiring, health/readiness, logging and monitoring, backup and migration procedure | owning repository, or system-level when the orchestration root defines it; the files that define it |
| `D` | Documentation surface — README, setup and operations guides, API reference, docstrings, changelog | owning repository; the claims it makes that the code can confirm or refute |
| `N` | Non-functional constraint — only one a repository states: a performance budget, an accessibility standard, supported locales or platforms, a compliance note | where it is stated and how it could be measured |
| `CMD` | Command — build, lint, typecheck, tests, docs build, dependency audit (declared, or the ecosystem's lockfile audit when none is declared), or a system-level integration or end-to-end command | the repository it runs in, exact command, its source, whether CI gates on it, resources it needs |

**Component names** come from evidenced identifiers: the workspace member, module
or package name, the deploy or service name in orchestration configuration, or
the service catalogue entry, in that order. If there is none, the name is the
component's qualified root path. Component IDs are therefore stable across runs.
The other elements are numbered within a run for display and carry a name.
Repositories, principals and commands are inputs to rows, not rows of their own.
All IDs here are logical; evidence is stored under each entity's `artifact_key`
([state.md](state.md)).

**Stable subject keys.** Every subject also records a `subject_key` that does not
depend on per-run numbering: its kind plus its stable qualified anchors (the
route, schema, entry point or defining file) and its participants' component
IDs. For example, `J::<entry anchor>::<sorted component IDs>`. Carry-forward and
finding continuity match on `subject_key`, never on `J03`-style numbers.

**In-scope missing units.** Every repository or unit the resolved scope includes
but that could not be pinned gets a **placeholder component**:

- its ID is `<slug(identity)>/missing`, with `availability: MISSING`. The
  identity is sanitized exactly as for pinned repositories, because a referenced
  URL can carry credentials too;
- it records the anchors that referenced it;
- it gets its expected lane rows, all `DEGRADED`, with the reason "not checked
  out" or "not pinnable";
- every journey, contract or boundary evidenced to depend on it lists the
  placeholder as a participant, and those rows stay `DEGRADED`.

The placeholder exists in the inventory, the matrix and the release accounting,
even though its source cannot be inspected.

Trust-boundary kinds follow [vapt's surface table](../../vapt/SKILL.md) —
request handlers, the auth/session lifecycle, queries or commands taking external
input, rendering sinks, server-bound input, file and path handling, client-side
storage, outbound calls carrying credentials or user data, async consumers of
external payloads, and security configuration. *(If vapt is not installed, that
list is the whole taxonomy.)*

### Criticality

Mark a journey, contract or boundary **critical** when it authenticates or
authorises, moves money, reads or writes personal, tenant or regulated data,
performs a destructive or irreversible operation, or when the repositories or
the user name it as primary. Everything else is **standard**. Record the reason;
criticality drives severity calibration and the release assessment.

### Build the coverage matrix

Create one row per subject per expected lane. The lane table is the default. A
row whose subject turns out not to have the lane's concern is kept and marked
`NOT_APPLICABLE` with its reason, never silently removed. Each row records the
components it depends on and therefore the repository pins it depends on.

| Subject | STATIC | AUTOMATED | FUNCTIONAL | ADVERSARIAL |
|---|---|---|---|---|
| `C` component | routed code-quality specialist, or the hub's checklist rows for a stack without one; test-quality on its tests | its build, lint, typecheck and test commands, in its repository; plus a dependency audit of its lockfile — the repository's declared one, else the ecosystem's read-only audit (`pnpm audit --prod`, `npm audit --omit=dev`, `yarn npm audit`, `pip-audit -r`, `cargo audit`, `osv-scanner --lockfile`). An undeclared audit is never skipped as "not declared": a known-vulnerable framework version is a finding no code reading surfaces. If the audit cannot reach its advisory source, the row is `DEGRADED` naming the missing check, and the direct-dependency versions of the component's framework and runtime are recorded for manual advisory lookup | — (covered through journeys) | — (covered through boundaries) |
| `X` contract | provider and every consumer agree on the pinned definitions: fields, types, versions, error shapes | contract or consumer-driven tests, where they exist | exercised through the assembled topology | — |
| `J` journey | trace the path through every participating component; map which tests exercise it | the tests that exercise it: present and green | walk it on the local system, assembled when it crosses components | — |
| `B` trust boundary | security-audit; the backend specialist's security rows | existing authorization or abuse tests: present and green | — | vapt AUDIT |
| `S` data store | schema, migration, ownership, tenancy and retention review | declared schema check commands that do not mutate a datastore | migrations and seeds apply cleanly to the disposable datastore (stateful authority) | — |
| `I` integration | secret handling, timeouts, retries, failure paths, signature verification | contract or stub tests | a journey through it with the stub | inbound callbacks are boundaries |
| `O` operations | CI, container, orchestration, infrastructure, configuration, health, logging review | CI-declared build and package commands | each deploy unit boots from documented configuration and its health check answers; the orchestration root assembles the topology | security headers and CORS are boundaries |
| `D` documentation | docs-accuracy review | docs build or link check, when declared | the documented setup steps bring the system up in the worktrees | — |
| `N` constraint | where it is enforced in code or configuration | declared performance, accessibility or locale tests | a measurement only if a repository ships the harness | — |

A dash means no row is created: that concern is covered by the subject named in
the cell.

A **cross-system row** depends on more than one component. Its evidence counts
only when every participating component ran at its pinned commit in the assembled
topology. If any participant is missing, a placeholder, unbuildable or
unrunnable, the row is `DEGRADED` and names that component. It is never passed on
the strength of the components that did run.

**Stubs.** A stub may stand in only for a genuinely external integration or a
unit the user explicitly placed out of scope. For an in-scope missing unit, a
stub's result is partial evidence attached to the row. It never makes that row
`PASS`.

**Test adequacy is this skill's own method, not test-quality's.** test-quality
judges whether test code is good. Whether each critical journey, contract and
boundary has any test at all is a mapping from the inventory to the test suites
of every participating repository, recorded on the `AUTOMATED` rows. A critical
journey with no test is a directly checkable finding.

### Capability preflight

Check each capability before a row depends on it and record the result:

- a companion **skill** is available when it is in the available-skill list or
  its sibling folder is installed;
- a **CLI** or toolchain is available only when its version command succeeds;
  check each one per repository that needs it;
- a **browser** is available when a browser-automation tool is callable or a
  repository ships an end-to-end runner that can be executed;
- a **disposable datastore** is available when a container runtime, in-memory
  engine or a repository's own test-database mechanism works here;
- **assembly** is available when the orchestration root's configuration can bring
  the participating components up together from the worktrees;
- **principals** are available when fixtures or seeds can produce each identity
  the critical rows need;
- **concurrency** is available when independent workers or processes can be
  dispatched and return results;
- each lane's **time ceiling** is declared: the CI job's timeout where one is
  configured, otherwise a stated value.

### Bounds

Inventory uses at most three discovery waves; each wave dispatches its
independent reads together, across repositories. An element still unresolved
after the third wave is recorded as unresolved, and its rows are `DEGRADED` with
the reason. It does not open a fourth wave.

### Rules of engagement — one question, at most

Once the preflight shows whether runtime is feasible, settle runtime authority
before EVIDENCE:

- If runtime is feasible and the request neither granted nor declined the
  stateful or adversarial class, ask once, bundled: propose the targets, the
  disposable datastores, the stubs, the assembled topology and the lanes found
  above, and offer "static and repository checks only" as a complete answer.
  That is `WAIT_FOR_USER`.
- If the request already answered, or runtime is not feasible, do not ask.
  Record the unauthorized classes, and their rows become `DEGRADED`.
- If the user explicitly requires runtime evidence and the only reachable target
  is unsafe, do not proceed against it; ask for a safe target. Otherwise record
  the runtime rows as `DEGRADED` and continue.

Record the answer's words in `authority.granted_by` and the rules of engagement
in the manifest.

**INVENTORY exits** when every inventoried subject, including every placeholder
for an in-scope missing unit, has at least one row, every
row names its lane, method, specialist (or `none — direct inspection`),
criticality and the components it depends on, the capability preflight is
recorded, the rules of engagement are recorded (or the one bundled question is
the pending `WAIT_FOR_USER`), and `inventory.md` and the manifest are written.
