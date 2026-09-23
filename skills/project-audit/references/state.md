# State — artifacts, manifest, outcomes, drift and resume

Loaded at SCOPE (to create the run) and at REPORT (to close it), and on every
resume. This file owns the artifact layout, the manifest schema, the four row
outcomes, the drift rule and the resume procedure. Other files point here rather
than restating them.

## Artifact layout

Everything the audit writes lives under one run directory in the **audit root**
repository's checkout ([scope-inventory.md](scope-inventory.md) chooses it).
Nothing else in that checkout, or in any other repository in the set, is created,
edited or deleted. The one exception is the temporary worktree metadata Git keeps
for this run's own audit worktrees.

```text
.specs/project-audit/
└── <run-id>/
    ├── manifest.json     durable state; the only source of truth on resume
    ├── inventory.md      the system model, every element citing a qualified anchor
    ├── tracker-draft.json optional reviewed payloads and publication results
    ├── evidence/
    │   └── <artifact_key>/   logs, transcripts, specialist reports, exported patches
    └── report.md         backlog, coverage and release assessment (REPORT)
```

- **Run ID:** `pa-<UTC yyyymmddThhmmssZ>-<first 7 of the system digest>`, fixed
  at SCOPE and never reused. A different pin vector is a new run.
- **Every source path is qualified** as `<repo-id>:<repo-relative path>`, in the
  manifest, in evidence and in the report. Audit-worktree prefixes are stripped.
  A qualified path is text to cite, never a destination to write to.
- **Evidence directories are named only by `artifact_key`** (below), never by a
  raw repository, component, subject, row, command or specialist name.
- **Writes are atomic.** Write `manifest.json` to a temporary sibling and rename
  it over the old file. A truncated manifest makes the run unresumable.
- **Write the manifest after every state change** — phase entry/exit, each row
  outcome, each degradation, each wait. A result held only in conversation
  context does not exist on resume.
- **Evidence never holds a real secret.** Redact tokens, keys, cookies,
  passwords and connection strings to `<redacted>` before writing a log. Seeded
  fixture data only; never a real customer record.
- **The directory is local and uncommitted.** The audit never commits or pushes
  it. The optional publishing workflow reads from it but posts only the reviewed,
  redacted fields in `tracker-draft.json`. When `report.md` contains an
  exploitable path, its header says so: it must not become public before the fix
  exists.

## Identifiers and paths

Names come from repository metadata: remote URLs, directory names, manifest
entries, route and service names. That makes them untrusted as filesystem paths
and as stored text. Logical IDs and display names stay in the manifest. Anything
that becomes a path or a hash input is derived as follows.

**Repository identity is secret-free before anything uses it.** Take the `origin`
URL and reduce it to `host[:port]/path`:

- scp-like `user@host:path` → `host/path`;
- `ssh://user@host[:port]/path` → `host[:port]/path`;
- `https://user:token@host[:port]/path?query#fragment` → `host[:port]/path`.

Drop the scheme, all userinfo, the query and the fragment. Lowercase the host,
and remove a trailing `/` and `.git`. If the result still contains `@`, `?`, `#`
or whitespace, or the remote has any other form, it is not provably secret-free.
In that case, and when there is no remote, use the repository's path relative to
the audit root. Record which source was used, and why, in `identity_source`.
Sanitize before the system digest is computed and before the manifest is first
written. The raw remote URL is never stored, hashed, reported or copied into
evidence.

**Short hash.** `hash<n>(text)` is the first `n` hex characters of
`git hash-object --stdin` over the exact bytes of `text`, with no trailing
newline.

**Slug.** `slug(text)`: lowercase, replace every run of characters outside
`[a-z0-9]` with `-`, trim leading and trailing `-`, and truncate to 40
characters. If nothing remains, use `x`. A slug matches `[a-z0-9][a-z0-9-]*`, so
it never contains `.`, `/`, `\`, `:`, a drive prefix or NUL.

**Repository ID** = `slug(display name)`. The display name is the last path
segment of the identity, or the checkout's directory name, and is stored
separately as `display_name`. Reuse an earlier run's ID for the same identity
when that ID matches the slug pattern. When two identities would share an ID, in
this run or against an earlier run's identity map, both become
`<slug>-<hash8(identity)>`. That keeps the choice deterministic and independent of
order.

**Logical IDs** — component `<repo-id>/<name>`, subject, row, command
(`CMD-NN`), specialist report — are manifest keys only. **Every evidence-bearing
entity** gets `artifact_key = <slug(logical ID)>-<hash10(logical ID)>`. For
example, `orders-service/api.STATIC` becomes `orders-service-api-static-` plus
ten hex characters. The adversarial export for a repository uses the logical ID
`adversarial:<repo-id>`. The manifest's `artifacts` map sends every
`artifact_key` back to its logical ID and kind. Never concatenate a raw logical
ID into a path.

**Contain before touching.** Before creating, writing, staging or removing any
worktree or artifact destination:

1. Resolve it to a canonical absolute path, following symbolic links on every
   existing ancestor (for example with `realpath`, or the runtime's equivalent).
2. Resolve its intended root the same way. For worktrees, the root is the run's
   audit temporary directory. For artifacts, it is
   `.specs/project-audit/<run-id>/` in the audit root's checkout, and that root
   must itself resolve inside that checkout.
3. Confirm the destination is strictly beneath the root.

A destination that fails any of these steps ends the run `INCOMPLETE`, with the
offending logical ID and path recorded. Never normalize an escaping path and
continue. Removal also requires the path to be a worktree this run recorded.

## Manifest schema

`manifest.json`, `schema: "project-audit/manifest@2"`. Every field is required
unless marked optional; unknown is written as `null` with a reason, never
omitted.

| Field | Content |
|---|---|
| `run_id`, `schema`, `created_at`, `updated_at` | identity and UTC timestamps |
| `status` | `IN_PROGRESS`, `WAITING_FOR_USER`, or a terminal status from the spine |
| `status_reason` | why the run is waiting or ended; the exact blocker for `INCOMPLETE` |
| `phase` | `SCOPE`, `INVENTORY`, `EVIDENCE`, `RECONCILE` or `REPORT` |
| `system` | `digest`, `audit_root` and `orchestration_root` (repository IDs or `null`), and `repositories`: one entry per pinned repository — `id`, `display_name`, `identity` (secret-free), `identity_source`, `local_path`, `ref`, `commit`, `excluded_uncommitted`, `worktrees` (path and purpose of each audit worktree), `evidence` for its membership in the set |
| `artifacts` | `artifact_key` → logical ID and kind, for every evidence directory |
| `missing_units` | referenced repositories or units that could not be pinned: secret-free identity, the anchors that reference them, and either `out_of_scope` with its reason, or `in_scope` with the placeholder component ID and `availability: MISSING` |
| `scope` | the user's request verbatim, `in_scope` units, `out_of_scope` items each with a reason |
| `authority` | granted action classes, `granted_by` (the user's words, quoted), and the rules of engagement: targets, datastores and why each is disposable, stubs for third parties, forbidden targets |
| `capabilities` | per skill, CLI or toolchain (per repository), browser, container/runtime, assembly, credential/fixture and concurrency carrier: `status` (`AVAILABLE`/`UNAVAILABLE`), the check that decided it, and its effect on rows |
| `inventory` | subject IDs with kind, stable `subject_key`, owning repository or participating components (placeholders included), criticality and the reason for it (detail lives in `inventory.md`) |
| `commands` | `CMD-NN`: purpose, repository it ran in, exact command, source (qualified anchor), lane, timeout, `exit_code`, duration, evidence path, outcome |
| `coverage` | the matrix rows (below) |
| `degradations` | `DG-NN`: `kind` (`coverage`, `independence`, `performance`), cause, affected rows and components, whether any affected row, component or missing unit is critical, `resolved` (true only when later evidence closed the gap), and the action that would close it |
| `findings` | the reconciled finding records ([reconcile-report.md](reconcile-report.md) owns the schema) |
| `release_assessment` | the category and its one-line reason (REPORT) |
| `publication` | optional post-audit state: tracker kind and secret-free destination identity, draft digest, status (`DRAFT`, `WAITING_CONFIRMATION`, `PUBLISHING`, `PARTIAL`, `PUBLISHED` or `FAILED`), selected finding IDs, per-finding requested item type, stable marker, external item ID/URL when known, and append-only attempts; governed by [publish.md](publish.md) and never used to compute the audit status or assessment |
| `checkout_drift` | per repository at REPORT and each resume: live head and the number of commits past its pin |
| `cleanup_debt` | audit-owned worktrees that could not be removed: repository and exact path |
| `events` | append-only: `{at, event, phase, detail}` for phase entry/exit, dispatch waves, joins, integrity checks, waits, resumes and drift |

A coverage row:

| Field | Content |
|---|---|
| `row_id` | `<subject-id>.<LANE>`, e.g. `J03.FUNCTIONAL`, `orders-service/api.STATIC` — a logical ID, never a path |
| `artifact_key` | the row's evidence directory name, derived as above |
| `subject`, `kind`, `criticality` | from the inventory |
| `lane` | `STATIC`, `AUTOMATED`, `FUNCTIONAL` or `ADVERSARIAL` |
| `components`, `pins` | every component the row depends on, and the `repo-id → commit` entries for their repositories |
| `method` | what was actually done, concretely enough to repeat |
| `specialist` | the routed skill and mode, or `none — direct inspection` |
| `read_set` | the qualified paths a `STATIC` row read, per repository (used for carry-forward) |
| `state` | `PENDING`, `RUNNING` or `DONE` |
| `outcome` | one token from the table below, only when `state` is `DONE` |
| `reason` | required for `NOT_APPLICABLE` and `DEGRADED`; optional otherwise |
| `evidence` | `evidence/<artifact_key>/` paths, qualified anchors, or `CMD-NN` references |
| `findings` | linked finding IDs |
| `degradations` | every `coverage` degradation affecting this row, whatever its outcome |
| `collected_at` | the event that recorded the result |

## Row outcomes

A row carries exactly one of four tokens. Blank, missing or unrecognised
outcomes fail closed: the row counts as not run.

| Token | Means |
|---|---|
| `PASS` | the method ran in full on the pinned commits of every component it depends on and produced no linked finding |
| `FAIL` | the method ran and at least one linked finding is `CONFIRMED` |
| `DEGRADED` | the method could not run in full or could not decide: missing capability, authority, credential, specialist, participating component or time; partial coverage; or only `SUSPECTED` findings. `reason` names the cause and what would close it |
| `NOT_APPLICABLE` | the subject genuinely has no concern for this lane; `reason` states the evidence (for example "no request handlers: the component is a build-time code generator") |

Precedence when several apply: `FAIL`, then `DEGRADED`, then `PASS`. A `FAIL`
row that also had partial coverage keeps `FAIL` for display, records the gap as a
`coverage` degradation, and links it in the row's `degradations`.

**A FAIL never cancels a gap.** The displayed outcome is not the coverage
statement. Release assessment and reporting read the unresolved `coverage`
degradations directly, never only the outcome token. A critical row that shows
`FAIL` because one finding was confirmed, while part of it went unexercised, is
still an unresolved critical gap.

A missing capability is `DEGRADED`, never `PASS` and never `NOT_APPLICABLE`. "We
could not run a browser" is not evidence that the journey works, and it is not
evidence that the journey has no UI. There is no `NOT_TRIGGERED`: rows are
created from inventoried subjects, so a subject without the concern is
`NOT_APPLICABLE` with its reason.

## Drift

Evidence is collected from detached audit worktrees at the pinned commits, so
edits in any live checkout cannot enter it. Two kinds of drift remain, and both
are handled per repository.

**Audit-induced drift** — a command or worker changed a tracked file in an audit
worktree. The integrity check runs at every join, for every worktree used since
the last join:

```text
git -C <worktree> rev-parse HEAD                              # must equal that repository's pinned commit
git -C <worktree> status --porcelain --untracked-files=no     # must be empty
```

On a mismatch: record a `drift` event naming the repository, the worktree and the
command or worker that ran since the last clean check. Invalidate every row that
depends on that repository and was collected after that check, including
cross-system rows that merely include one of its components. Restore that audit
worktree to its pin; it is disposable and audit-owned, and this is never done to
a live checkout. Rerun the invalidated rows once. A repository-declared command
that rewrites tracked sources in its CI form is itself a finding. A second
mutation from the same command makes its rows `DEGRADED` rather than looping.

**The one expected change: vapt's dedicated worktree.** Abuse tests written by
vapt are expected changes, but only in the audit worktree dedicated to it. Before
the join:

1. List every changed and untracked path in that worktree.
2. Classify each path into exactly one allowed set: an abuse test or fixture in
   the repository's evidenced test layout, or a vapt tracking artifact under
   `.specs/vapt/`. Any other product, configuration or unclassified path is drift.
3. Stage only the validated test and fixture paths, passed as literal path
   arguments after `--`, and export that cached binary diff as the abuse-test
   patch. Never use `git add -A` for this export.
4. Copy the `.specs/vapt/` tracking artifacts separately into the same
   containment-checked evidence directory; they are evidence, not part of the
   adoptable test patch.
5. Restore that worktree to its pin and run the integrity check. It must pass.

A changed path outside those two allowed sets is audit-induced drift. Neither
the patch nor the tracking artifacts are exported as trusted evidence, and the
rows it affected follow the rule above. The strict integrity rule applies
unchanged to every other worktree.

**Checkout drift** — a repository's live checkout moved past its pin. This
invalidates nothing: the evidence describes the pinned system state, and the
report says so. At REPORT and on resume, record each repository's live head and
the number of commits past its pin in `checkout_drift`. The report header states,
per repository, that those commits were not audited. Never describe the audit as
covering any current head.

**A changed pin vector is a new run** with a new digest. A new run may carry a
`STATIC` row forward from a prior run only when its subject has the same
`subject_key` in both runs (never matched by display numbers such as `J03`) and
all three hold:

- for every repository in the row's `read_set`, `git -C <repo> diff --name-only
  <old commit> <new commit>` shares no path with that repository's part of the read
  set;
- no contract (`X`) that involves one of the row's components changed on any side
  (provider or consumer anchors, in any repository);
- the row's components still belong to the same repositories.

A carried row is marked `reused_from: <run-id>/<row-id>`. `AUTOMATED`,
`FUNCTIONAL` and `ADVERSARIAL` rows are never carried forward: they depend on
whole builds and on the assembled topology.

## Resume

The resume contract covers only runs that have a manifest. The pre-run scope
question ([scope-inventory.md](scope-inventory.md)) is asked before any manifest
exists, so it has nothing to resume. Answering it restarts SCOPE from the
resolved set.

1. **Select the run.** The one the user names, otherwise the most recent
   manifest in the audit root whose `status` is `IN_PROGRESS` or
   `WAITING_FOR_USER`. State which run is resuming. A terminal run is never
   reopened; more work is a new run.
2. **Verify every pin exists:** `git -C <repo> cat-file -e <commit>^{commit}`
   for each repository, then recompute the system digest from the recorded
   identities and commits. If a repository or commit is gone, or the recomputed
   digest differs from the recorded one, mark the run `INCOMPLETE` with that
   reason and offer a new run. Never guess which value is right, and never
   continue.
3. **Restore the worktrees.** Reuse a recorded worktree only when it passes the
   integrity check. Otherwise remove that recorded worktree and add a fresh one
   at the same pin and layout path. Both the removal and the new destination pass
   the containment check first.
4. **Re-run the capability preflight.** Capabilities change between sessions.
   Recorded authority stands unless the rules of engagement name a target or
   datastore that no longer exists; then re-establish them before any runtime
   row.
5. **Take up the rows.** `DONE` rows keep their outcome when their evidence
   files still exist. `RUNNING` rows had no recorded result and restart.
   `PENDING` rows run normally. A `DONE` runtime row stays valid after its
   environment was torn down, because it was collected against the pins.
6. **Record checkout drift** as above, then continue from the recorded phase.
7. **Keep finding IDs.** IDs already assigned never change on resume.

If the audit root contains a manifest whose schema this file does not describe,
do not guess: state it and start a new run.
