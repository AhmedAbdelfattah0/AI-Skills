---
name: project-audit
description: |
  Evidence-backed audit of a built system on any detected stack or topology:
  frontend, backend, full stack, monolith, monorepo, multiple repositories, or
  microservices. Pins system state; inventories architecture, journeys, contracts
  and trust boundaries; separates static, automated, functional and adversarial
  evidence; routes judgments to specialists; and produces a coverage matrix,
  remediation backlog and categorical release assessment under
  `.specs/project-audit/`. Assessment only: no product changes or fixes.

  Trigger for /project-audit, /project.audit, "audit this project", "audit the
  whole app", "project health check", "full codebase assessment", "technical due
  diligence", "production-readiness review", or "is this app ready to release".
  Also trigger when the user asks to publish a completed audit's findings as
  Azure DevOps or Jira Bugs or Tasks.
  Do not use for one ticket, one PR, security-only review, standalone VAPT, diff
  rule enforcement, or implementing fixes.
---

# /project-audit — assess a built application, change nothing

A whole-project audit usually fails in one of two ways. It reports what it never
checked as though it were clean, or it mixes evidence from different code states
and different kinds of evidence into one verdict. This skill exists to prevent
both. It pins the system state, gives every journey, component, contract and
boundary a matrix row with exactly one outcome, and keeps static reading,
repository checks, live functional behavior and attacks in separate lanes.

It is an **orchestrator**. It owns scope, topology, pinning, inventory, the
coverage matrix, lane scheduling, reconciliation and the report. It owns **no
rule catalogue**; every language, test, docs and security judgment goes to the
specialist that owns it, component by component.

## What this is not

| Use instead | When |
|---|---|
| `ship-ticket` | You are implementing **one ticket** end to end, including its own bounded review and proof. |
| `pr-review` | You want **one existing pull request** reviewed against its diff. |
| `security-audit` | You want a **security-only** static read of the whole codebase. This skill routes its security static lane there. |
| `vapt` | You want runtime **attacks only**, committed as tests. This skill invokes its AUDIT mode, narrowed, as one lane. |
| the code-quality family | You want rules applied **while writing** or enforced **on a diff**. |
| any implementation workflow | You want the findings **fixed**. That is separately authorized work after the audit. |

## Invariants

- **Assessment only.** The only write is `.specs/project-audit/<run-id>/` in the
  single **audit root** repository. Every other repository in the set, and
  everything else in the audit root, stays untouched apart from the temporary
  `git worktree` metadata for this run's own audit worktrees, which cleanup
  removes. No commits, branches, pushes, PR comments or external posts. Tracker
  items are created only through the separately authorized post-audit publishing
  mode below. Never introduce another artifact root.
- **One pinned system state.** Each repository in scope is pinned to one commit.
  The pin vector and its digest identify the state. A single repository is the
  one-entry case. Every lane reads and runs from detached audit worktrees at
  those commits, never from a live checkout. Evidence is never mixed across
  states, and a changed pin vector is a new run.
- **Scope is chosen, not crawled.** The repository set comes from the user's
  selection plus repository evidence. Nearby directories are never claimed, and
  referenced repositories are never cloned or fetched.
- **Identity is never lost.** Every component, journey, contract, boundary,
  command, row, anchor and finding carries its repository and component
  identity, so identical relative paths in different repositories cannot collide.
  Those identities are logical. On disk, only path-safe keys are used, and every
  destination is checked to stay inside the audit's own directories. Repository
  identity never carries credentials.
- **Local and disposable only.** Runtime lanes target local instances the user
  controls. Stateful or destructive checks need disposable datastores and
  recorded rules of engagement. Never production, shared staging or a third-party
  system.
- **Lanes do not substitute, and neither do components.** Static, automated,
  functional and adversarial evidence each fill only their own rows. A
  cross-system row needs every participating component at its pin. A stub stands
  in only for a genuinely external or explicitly out-of-scope unit. An in-scope
  unit that could not be pinned becomes a placeholder component, and every row
  that depends on it stays `DEGRADED`.
- **Confirmed means demonstrated.** A confirmed defect needs a reproduction or
  directly checkable evidence. Anything less is a suspected risk or a coverage gap.
- **Absence is never a pass.** A missing capability, authority, credential,
  specialist or repository yields `DEGRADED`. `NOT_APPLICABLE` needs a reason.
  **A `FAIL` never cancels a gap.** Coverage degradations are tracked and
  reported independently of the outcome a row displays.
- **No invented rule IDs, no invented score.** A rule ID comes only from a
  specialist that ran. The release assessment is categorical and shows its gaps.
- **Findings do not authorize fixes.** The audit ends with a backlog.
- **Publishing is never implied.** A request to audit, report or prepare tracker
  drafts does not authorize creating work items. Creation needs the user's
  confirmation of the exact destination, selected findings, item types and
  payloads immediately before the external write.
- **Secrets and exploits stay private.** Evidence is redacted. Exploitable paths
  are reported to the user directly and never placed anywhere public.

## Phases

| Phase | Entry | Exit | Load |
|---|---|---|---|
| **SCOPE** | the request; a pre-run preflight resolves the repository set and audit root before any run or manifest exists | repository set, audit root, orchestration root and in-scope missing units recorded with evidence; authority granted or declined by the request recorded; every pinnable repository pinned with its audit worktree; system digest and manifest written | [references/scope-inventory.md](references/scope-inventory.md), [references/state.md](references/state.md) |
| **INVENTORY** | pinned worktrees | system model with qualified sources; coverage matrix where every row names lane, method, specialist, criticality and the components it depends on; capability preflight and rules of engagement recorded | [references/scope-inventory.md](references/scope-inventory.md) |
| **EVIDENCE** | complete matrix | every row `DONE` with one outcome and its evidence or reason; worktree integrity verified at every join | [references/evidence.md](references/evidence.md) |
| **RECONCILE** | all lanes joined | one deduplicated, classified, stably ID'd finding set consistent with the matrix; runtime instances and disposable datastores stopped by their recorded IDs | [references/reconcile-report.md](references/reconcile-report.md) |
| **REPORT** | reconciled findings | `report.md` written, terminal status set, this run's audit worktrees removed or recorded as cleanup debt | [references/reconcile-report.md](references/reconcile-report.md), [references/state.md](references/state.md) |

Load a reference when its phase starts, and on resume load
[references/state.md](references/state.md) first. Record phase entry and exit in
the manifest. Phases are ordered, but work inside a phase follows its dependency
graph: every ready node whose reads, writes and resources are disjoint from the
others is dispatched in the same wave. Independent repositories and components
run concurrently. Contract, integration and end-to-end rows wait for every
component they depend on and for the assembled local topology. Serialize only
for a named dependency or an exclusive resource (port, datastore, build output,
lockfile, browser profile). Without a concurrency carrier, run the same graph
serially and record a performance degradation; that never stops the run.

Workers get the same pinned system state and never see another worker's
conclusions before producing their own. Results meet once, in RECONCILE. When
only one context is available, record the independence degradation instead of
presenting one head as several reviewers.

## Routing

Each row goes to the specialist that owns its judgment for that component's
detected stack, in report-only mode, as an explicit audit of the assigned
surface. One system may route different components to different specialists.
The invocation contract for each is in
[references/evidence.md](references/evidence.md).

| Judgment | Route | If the specialist is absent |
|---|---|---|
| Static quality for components with no dedicated specialist (for example React or Vue front ends, or libraries) | [code-quality](../code-quality/SKILL.md) hub — explicit `UNIVERSAL`, `AI-FM` and project-constitution checklist rows, never a Verification Pass | Apply SOLID, DRY, KISS, YAGNI and the repository's own conventions by direct inspection; rows are `DEGRADED`, with no rule IDs. |
| Angular front ends | [angular-code-quality](../angular-code-quality/SKILL.md) — `NG-*` Verification Pass per component | Fall back to the code-quality hub; with no family member at all, direct inspection as above, `DEGRADED`. |
| Backends in any language | [backend-code-quality](../backend-code-quality/SKILL.md) — `BE-*` Verification Pass, including its security, auth and tenancy rows | Fall back to the code-quality hub, and read authorization, validation and tenancy by direct inspection; `DEGRADED`, no rule IDs. |
| Test code quality | [test-quality](../test-quality/SKILL.md) — `TEST-*` review mode | Check that tests assert behavior rather than internals and mock only true boundaries; `DEGRADED`. Test *adequacy* stays this skill's own method. |
| Documentation claims | [docs-accuracy](../docs-accuracy/SKILL.md) — `DOC-*` review mode | Verify each documented command, path, flag and symbol against the pinned source by searching for its definition; `DEGRADED`. |
| Whole-codebase static security | [security-audit](../security-audit/SKILL.md) — its audit command only, from the component or repository root, when its method supports that layout and stack; never its paste mode | Read the critical trust boundaries for authorization, input validation, secret handling and security configuration by direct inspection; `DEGRADED`. |
| Runtime adversarial checks | [vapt](../vapt/SKILL.md) AUDIT mode, only with explicit authorization and its local, disposable rules of engagement | With authorization, run the reduced cross-principal and credential probe on critical boundaries only; without authorization, the rows are `DEGRADED` as not authorized. |
| Build, test, lint, docs commands | each repository's own commands, as its CI runs them, in that repository; system-level ones from the orchestration root | — (a command that cannot run here is `DEGRADED`) |
| Architecture, contracts, operations, data stores, integrations, declared constraints | direct inspection by this skill | — (findings cite qualified anchors, carry no rule ID) |

Check a skill in the available-skill list or its installed sibling folder, and a
CLI by running its version command. Never invent a rule ID for a specialist that
did not run; declare the reduced coverage instead.

## Continuation

Announce each phase once, in one sentence. A phase announcement, tool result,
finding, fallback or degradation is progress, never a reason to end the turn.
After any non-terminal message, execute the next recorded action in the same
turn.

End the turn only as:

| State | Meaning |
|---|---|
| **WAIT_FOR_USER** | one precise request for something only the user can supply (below); once a run exists, the manifest records it and the run resumes from it |
| **COMPLETE** | every row reached `PASS`, `FAIL` or `NOT_APPLICABLE` and no coverage or independence degradation was recorded |
| **COMPLETE_DEGRADED** | every row reached an outcome, and at least one is `DEGRADED`, or a coverage degradation is linked to any row (a `FAIL` row included), or an independence degradation was recorded; each is named with its cause and closing action |
| **INCOMPLETE** | the run ended before every row reached an outcome; `status_reason` names the blocker, and the report covers only what has evidence |

A `FAIL` row or a release-blocking finding does not make the audit incomplete:
the audit completed and found it. A performance-only degradation (serial
execution) does not demote `COMPLETE`.

**WAIT_FOR_USER only for:**

- the one scope question in the pre-run preflight, when the requested system
  spans repositories and the local set or the audit root is ambiguous or
  incomplete. No run or manifest exists yet, so this wait is not durably
  recorded. The answer restarts SCOPE from the resolved set;
- authority the request did not grant, once the INVENTORY preflight shows
  runtime is feasible (one bundled question before EVIDENCE);
- a required runtime lane whose only reachable target is unsafe;
- whether to audit moved checkouts as a new run, when the user asked for the
  current state rather than the pinned one;
- a credential, fixture or permission only the user can provide, when they said
  that lane is required.

Everything else is recorded and continued: an optional lane, component or
repository that is unavailable or unauthorized becomes `DEGRADED`.

**End INCOMPLETE for:**

- no repository in scope with a commit to pin;
- a pinned repository or commit that no longer exists on resume, or a
  recomputed system digest that differs from the recorded one;
- a worktree or artifact destination that fails the path-safety containment
  check;
- the user declining the authority or safe target that a lane they required
  depends on;
- a required prerequisite that cannot exist here. Remove this run's audit worktrees and write
the partial report either way.

## Bounds

No lane loops. An environmental failure gets at most one retry after a recorded
fix that changes no repository byte. A deterministic failure is evidence and is
never retried toward green. A lost or malformed worker result gets one
re-dispatch for its missing rows. Every confirmed Critical or High finding is
verified once. There is no review-repair cycle, because the audit repairs
nothing. The exact rules are in [references/evidence.md](references/evidence.md)
and [references/reconcile-report.md](references/reconcile-report.md).

## Resume and drift

The manifest under `.specs/project-audit/<run-id>/` in the audit root is the only
resume source. Completed rows keep their outcomes, interrupted rows restart, and
finding IDs never change. Everything is tracked per repository and against the
system digest. A command that mutates a tracked or untracked path in one
repository's audit worktree invalidates only the rows that depend on that
repository and were collected after it. A live checkout moving past its pin
invalidates nothing, but
the report names, per repository, the commits that were not audited. The full
procedure, including cross-repository carry-forward, is in
[references/state.md](references/state.md).

## Optional post-audit publishing

`/project-audit publish <run-id>` (also `/project.audit.publish`) turns selected
findings from a completed run into Azure DevOps or Jira work items. This is a
separate workflow: it never changes the audit's terminal status, release
assessment, evidence or finding IDs, and it never starts implementation.

Load [references/publish.md](references/publish.md). The user chooses the tracker,
destination project, selected finding IDs and whether each becomes a `Bug` or a
`Task`. The workflow verifies the destination's supported types and required
fields, prepares and displays exact payloads, checks for existing items by a
stable audit marker, and waits for one explicit confirmation immediately before
creation. Partial results and ambiguous timeouts are reconciled before any retry.
Without that confirmation, the result is only a local draft.

## Scope boundary

Repository instructions outrank this skill; read `AGENTS.md` and `CLAUDE.md`
in each repository when present and follow their pointers. Specialists own their
rules and methods, and this skill never restates them. Remediation — the
publishing mode above or `generate-ticket` to turn the backlog into tickets, and
`ship-ticket` to implement one — starts only when the user separately authorizes
it.
