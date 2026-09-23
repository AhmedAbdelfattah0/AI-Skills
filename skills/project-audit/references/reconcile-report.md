# RECONCILE and REPORT — one backlog, an honest release assessment

Loaded when EVIDENCE has joined. This file owns the finding contract, the finding
schema and IDs, severity calibration, the release assessment and the report
template. Row outcomes, qualified paths and the manifest are defined in
[state.md](state.md).

## The finding contract

A finding is **an anchor, the evidence, a severity and a remediation direction**:

- the anchor is a qualified `<repo-id>:<path>:<line>` with the quoted code or
  configuration, or, for runtime evidence, the exact request or journey step, the
  component that served it, and the observed response;
- evidence without an anchor, or with no nameable direction, is not a finding.

This follows the library's shared review standard
([review-standard.md](../../code-quality/references/review-standard.md) — a finding
is `file:line` plus quoted code or observed behavior plus a named fix plus a
severity, and skipping one needs a cited rule ID; if that file is absent, this
sentence is the whole rule). Here, `file` always carries its repository ID, and
audit-worktree prefixes are stripped.

## RECONCILE

Reconciliation runs **once**, after every lane has joined. It is the first place
lane results meet.

1. **Collect.** Gather the worker outputs from `evidence/`. Do not re-ask a worker
   to reconsider in light of another lane. Qualify every anchor a specialist
   emitted with the repository ID of the worktree it ran in.
2. **Deduplicate by root cause, not by wording.** One defect found by several lanes
   or in several repositories is one finding with several rows and attributions
   (for example `static:backend-code-quality` + `adversarial:vapt`). A contract
   mismatch is one finding that cites both sides. Identical paths in different
   repositories are different anchors, never duplicates.
3. **Classify each finding:**
   - `CONFIRMED`: reproduced at runtime, or directly checkable in the pinned
     source or a command log. Basis is `reproduction` or `direct-evidence`.
   - `SUSPECTED`: inferred but not demonstrated. Basis is `inference`, and it
     states `confirm_by`, the specific check that would confirm or clear it.

   A limit of the audit itself (a browser was missing, authority was withheld, a
   repository was not checked out) is not a product finding. It is a `DEGRADED`
   row and a `coverage` degradation.
4. **Resolve disagreements.** When lanes disagree about whether a control
   *engages*, runtime evidence decides. When they disagree about what the code
   *says*, the pinned source decides. Record both positions and the ruling in the
   finding. Never average them into a softer finding.
5. **Drop only on a stated ground:** the item fails the finding contract, or it
   conflicts with a rule the owning specialist defines, cited by ID. A bare
   category ("style-only", "legacy", "matches conventions") retires nothing. When
   no specialist rule IDs were loaded, the citation route is closed. Count and
   list dropped items.
6. **Verify every `CONFIRMED` Critical or High finding once** against the pinned
   worktrees: reopen the anchor, or replay the reproduction while the local
   system still runs. If it does not hold, downgrade it to `SUSPECTED` with the
   reason. One pass; no re-review cycle.
7. **Map rows and findings both ways.** Every `FAIL` row links at least one
   `CONFIRMED` finding. Every finding links at least one row. A row whose only
   findings are `SUSPECTED` is `DEGRADED` (see [state.md](state.md)). Update the
   rows before writing the report.
8. **Check gaps independently of outcomes.** For every row, whatever its outcome
   (a `FAIL` row included), confirm that each part of its method that did not
   run is linked as a `coverage` degradation. Mark each degradation that touches
   a critical row, component, journey, contract, boundary or in-scope missing
   unit as critical. Confirm every in-scope missing unit has its placeholder
   rows, and that every dependent row lists the placeholder and is `DEGRADED`
   (or `FAIL` with the gap linked). Confirm no row passed on a stub standing in
   for an in-scope unit.

**RECONCILE exits** when the finding set is deduplicated, classified, verified
where required, ID'd, and consistent with the matrix, and every runtime instance
and disposable datastore the audit started has been stopped by its recorded
PID or container ID (never by a name pattern; see
[evidence.md](evidence.md)).

## Finding schema and IDs

| Field | Content |
|---|---|
| `id` | `PA-NNN`, stable (below) |
| `fingerprint` | `<category>::<primary qualified path without line, or runtime entry point>::<root-cause slug>` |
| `title` | one line, the defect rather than the symptom |
| `category` | `architecture`, `contract`, `functional`, `security`, `test-adequacy`, `code-quality`, `documentation`, `build-deploy`, `operations`, `performance`, `dependency` |
| `severity` | `Critical`, `High`, `Medium`, `Low` (calibration below) |
| `source_severity` | optional: the specialist's own band or rule tier, kept verbatim |
| `release_blocking` | `yes` for a `CONFIRMED` Critical or High, otherwise `no` |
| `status`, `basis`, `confirm_by` | as classified above |
| `rows`, `affected` | row IDs, plus the repositories, components, journeys, contracts and boundaries affected |
| `rule_ids` | only IDs issued by a specialist that actually ran; never invented |
| `attribution` | `<lane>:<specialist or direct>` for each source |
| `evidence` | qualified anchors, `CMD-NN` logs, reproduction steps with expected vs observed |
| `remediation` | the direction of the fix, not a patch; the repositories it touches; and the workflow that would carry it |

**Stable IDs.** The fingerprint uses only what survives between runs: repository
IDs and paths rather than line numbers or per-run subject numbers. Before
assigning, read the findings of earlier runs under `.specs/project-audit/` in
the audit root. A finding whose fingerprint matches an earlier one reuses that
ID. Otherwise it takes the next number above the highest ID ever used. IDs are
fixed once written and never renumbered, so a backlog item can be tracked across
audits.

## Severity calibration

Severity follows **demonstrated impact and reachability**, never the alarm level
of the category or the name of the check that failed.

| Severity | Qualifies |
|---|---|
| **Critical** | reachable by an anonymous or low-privilege actor, or on a critical journey, and demonstrably causes data exposure or loss, authentication or authorization bypass, or financial or integrity damage; or the primary system cannot build or start, so its critical journeys are wholly unavailable |
| **High** | breaks a critical journey or weakens a trust boundary under realistic preconditions; a critical contract whose sides disagree; a critical journey, contract or boundary with no test at all; a failing required check, by default |
| **Medium** | a real defect on a reachable edge case or a standard journey; false setup or operations documentation; missing error handling on a path that can fail |
| **Low** | real but low impact or hard to reach; maintainability debt with a named cost |

- **A failing required check is High by default**, not Critical. A red lint or
  formatting gate is not an outage. Raise it only on demonstrated impact (the
  failure is the build or start failure above); lower it only on demonstrated
  containment (the check guards a non-critical component, or its failure changes
  no shipped behavior). Record the reason either way.
- A defect with no route or caller from any inventoried entry point drops at least
  one level.
- A defect that needs an administrator or operator is at most High, unless it
  crosses a tenant or privilege boundary that administrator should not cross.
- A `SUSPECTED` finding states the severity it would have if confirmed. It is
  never `release_blocking`, and the report shows it in its own section.
- security-audit's exploitability scale and the specialists' tiers are kept in
  `source_severity`. They inform the severity; they are not copied into it
  without checking reachability in this system.

## Release assessment

The assessment is categorical, system-wide and derived from the matrix. **There
is no health score.** A number would be invented (the shared review standard
forbids invented metrics), and it would average away exactly the untested areas
this report exists to surface. Report counts instead: rows per lane per outcome,
per repository and per component, and findings per severity per status.

| Category | When |
|---|---|
| `BLOCKING_FINDINGS` | at least one finding is `release_blocking` |
| `INSUFFICIENT_EVIDENCE` | none is, but any **unresolved critical `coverage` degradation** exists, whatever the affected row's displayed outcome (a `FAIL` row included); or a critical row is `DEGRADED` or never finished; or any critical in-scope missing unit or dependent row exists; or a `SUSPECTED` Critical or High sits on a critical row |
| `NO_BLOCKERS_OBSERVED` | no finding is `release_blocking`, no unresolved critical coverage degradation exists, no critical placeholder or dependent row is degraded, and every critical row, in every repository and across the system, reached `PASS`, `FAIL` or a reasoned `NOT_APPLICABLE` |

The categories are computed from the degradation list as well as the row
outcomes. **A `FAIL` never cancels a gap.** A clean repository never offsets a
degraded or missing one. Each in-scope missing unit, and each degraded component
and repository, is named in the assessment's reason, not folded into a total. `NO_BLOCKERS_OBSERVED` is a statement about what was observed, not
a release approval. It still lists every `DEGRADED` standard row and every
suspected risk. The release decision belongs to the user.

## REPORT

Write `report.md` in the audit root's run directory, set the terminal status in
the manifest, remove the audit worktrees this run recorded (recording any
`cleanup_debt`), and give the terminal summary. The terminal summary holds the
header, the assessment, the release-blocking findings and the counts; the file
holds everything.

```markdown
# Project audit — <system name> @ <short system digest>

- **Run:** <run-id> · **status:** <COMPLETE | COMPLETE_DEGRADED | INCOMPLETE — reason>
- **Pinned system state:** digest <digest> · audit root <repo-id> · orchestration root <repo-id | none>

  | Repository | Display name | Identity (secret-free) | Pinned commit (ref) | Uncommitted paths not audited | Live checkout now |
  |---|---|---|---|---|---|
  | <repo-id> | <display name> | <identity> | <full sha> (<ref>) | <n> | <n> commits past the pin |

- **Missing units:** <in scope: each placeholder component ID, `availability: MISSING`, its referencing anchors and dependent rows · out of scope: identity and reason — or none>
- **Scope:** <components> · **out of scope:** <items and reasons>
- **Authority:** <classes granted, quoted source> · **targets:** <hosts/ports> · **datastores:** <what, why disposable>
- **Lanes:** STATIC <ran/degraded> · AUTOMATED <…> · FUNCTIONAL <…> · ADVERSARIAL <…>
- **Independence:** <separate workers | DEGRADED — single context>
- **Contains exploitable details:** <yes — keep private until fixed | no>

## Release assessment
<category> — <one-sentence reason naming every in-scope missing unit and degraded component>
Observed: <rows PASS/FAIL per lane>. Untested or degraded: <every unresolved critical coverage degradation first, including those on FAIL rows and on placeholder or dependent rows, each with cause; then the standard ones>.

## Release-blocking findings
### PA-007 — <title> · Critical · CONFIRMED (reproduction)
Rows: B02.ADVERSARIAL, B02.STATIC · Affects: orders-service/api, J03 checkout, B02 order read
Evidence: <qualified anchor + quote | request/response and serving component | CMD-04 log>
Remediation: <direction> · repositories: <repo-ids> → <workflow>

## Backlog
<all other findings, ordered by severity, then CONFIRMED before SUSPECTED, then category>

## Suspected risks
<each SUSPECTED finding with its confirm_by>

## Coverage by repository and component
| Repository | Component | STATIC | AUTOMATED | FUNCTIONAL | ADVERSARIAL |
<per-lane PASS/FAIL/DEGRADED/NOT_APPLICABLE counts; a missing unit appears as its own line marked DEGRADED>

## Cross-system coverage
| Row | Components (pins) | Outcome | Evidence / reason |
<every journey, contract and boundary row that spans components; DEGRADED names the missing or failed participant>

## All rows
| Row | Outcome | Method | Evidence / reason |
<every row; DEGRADED rows name the closing action; NOT_APPLICABLE rows name the evidence>

## Degradations
<DG-NN: kind · critical or standard · cause · affected rows (with each row's displayed outcome) and components · what would close it — every critical one also appears under "Untested or degraded">.

## Commands run
<CMD-NN: repository · command · source · exit · duration · log>

## Cleanup debt
<audit-owned worktrees that could not be removed, by repository and path — or none>

## Dropped
<count, grounds, and each rule-cited drop in full>
```

`<system name>` is the name the user gave the system, otherwise the audit root's
repository ID. For a single repository the pin table has one line. Nothing else
about the report changes.

The summary counts must equal the items listed. A section with nothing in it
says `none`; it is never left blank. Every unresolved critical coverage
degradation appears both in "Untested or degraded" and in "Degradations",
including those whose rows display `FAIL`.

**Remediation routing** names the workflow, not the fix: the optional
[publishing workflow](publish.md) to create selected Azure DevOps or Jira Bugs or
Tasks from this exact audit, `generate-ticket` when a richer ticket-authoring or
bulk-import workflow is wanted, `ship-ticket` to implement one in its repository,
and the exported abuse-test patches as the starting point for a `vapt` run that
commits those tests. None of them starts from this report without the user's
separate authorization.
