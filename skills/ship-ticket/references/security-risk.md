# Security risk — how the vapt catalog is applied to a ticket

Loaded when PLAN, PROVE or REVIEW handles security-relevant work. It describes
what `scripts/security-plan.mjs` and the engine do (policy 2); it adds no rule of
its own beyond them.

## 1. Ownership

[`vapt`](../../vapt/SKILL.md) owns the control catalog (`skills/vapt/controls.json`),
its evaluator (`controls.mjs`) and the attack classes. This file owns how
ship-ticket applies them: what the plan states, what the engine binds, what review
must cover. Fallback if `vapt` is not installed beside this skill: the catalog is
absent, `security-plan.mjs` refuses `catalog_missing`, and a policy-2 run cannot
start; never substitute an empty selection or a guessed list.

The `VAPT-ABUSE-*` classes have no static `BE-*` mirror; they are proven only by
the committed specs below.

## 2. When plan §3a is required

Required when any of these holds: the change is ELEVATED, security-sensitive, has
non-empty `riskLabels`, or a `vapt` trigger fires. Otherwise §3a is the three-line
compact form `select` prints for an empty selection: the line
`No security-relevant surface: <evidence>`, the `security-pairs sha256:<hex>` line
and the machine block. Plan §3b (impact and check applicability) names the
business flows and data that §3a's facts cite, and lists the checks the catalog
does not hold. Policy 2 itself (the DAG keys
below) is required for every run approved after the cutoff (section 11), so a
no-surface run still binds `controlCoverage: []`, an evidenced empty assessment.

## 3. Writing the security facts

Facts are the input to selection. Each fact in the catalog's `fact_vocabulary`:

- comes from a **complete inventory** of the changed surfaces
  (`surfaces[]`: `boundary_id`, `kind`, `path`, `principals[]`); `boundaries` and
  `principals` are derived from it and must not be supplied differently;
- carries a **citation**, a `path[:symbol]`, in `evidence`;
- is **explicitly unknown** when it is: `"unknown: <why>"`. Never default to
  `false`; an unknown fact keeps its controls selected;
- uses only vocabulary values (`fact_out_of_vocabulary` otherwise).

A surface path is a file; a directory path matches no signal. Paths use forward
slashes: a backslash in a surface path or a changed path is refused `bad_input`.

**Surface-level facts (block format 3).** A change-level fact is the OR of its
surfaces, so one `true` fact makes every gated pair of every surface applicable. A
surface may carry its own `facts` and `evidence` to say that a fact is false **for that
surface**, under five rules, each refused when broken:

- only a boolean fact, only lowered from `true` to `false`; never an `unknown` or a
  `false` change fact, never on a surface of kind `unknown`
  (`surface_fact_not_lowerable`);
- only a fact that a catalog `not_applicable` gate for the surface's kind names
  (`gated by <fact>[ or <fact>]: ...`), and only where lowering it drops at least one
  pair (`surface_fact_ungated`);
- with a machine-checkable citation: one repository-relative `path[:symbol]` naming
  a file, no placeholder such as `TBD` or `n/a` (`fact_uncited`). Brackets,
  parentheses and `$` are allowed in the path (`app/api/orders/[id]/route.ts:GET`).
  A citation is never a docs-only file (`README.md`, `CLAUDE.md`, `AGENTS.md`,
  `CHANGELOG.md`, `CONTRIBUTING.md`, `LICENSE`, or any markdown under a `docs/`
  folder), a path inside `.git/` or `node_modules/`, or a `:symbol` shorter than 3
  characters (`fact_uncited`). The cited file must **exist** with exactly that case
  on every OS, must resolve inside the repository (a symlink out, including into a
  sibling directory that shares the name prefix, is refused), must not be
  gitignored, and, with a `:symbol`, must contain it as a whole identifier
  (`exp` does not match `export`, `xexport` does not match `export`)
  (`citation_missing`). A symlink inside the repository is also judged by the file
  it resolves to: a target that is docs-only, inside `.git/` or `node_modules/`, or
  gitignored is refused. A citation with a `.` or `..` segment, or with a leading
  `./`, is refused `fact_uncited`. In a format-3 run, a surface or changed path with
  a `.` or `..` segment is refused `bad_input`; a leading `./` is normalized. A
  format-2 run takes such paths as it did before F12a. Every format-3 entry refuses
  them: select, reassess, the block parse and its replay (so `init`, `preflight`,
  the gates and the `obligations` CLI). Where each check runs:
  - at `init` and `preflight`, in the repository working tree (the plan's base);
    a path under a DAG node's `writes` (a file the change creates) is deferred;
  - at `gate review`, both original and confirmation, in the candidate work tree,
    with nothing deferred;
  - at `gate ship-ready`, before and after the proof, in the candidate work tree.
    A repair that removes the cited file or symbol never ships;
  - in the `obligations` CLI, in the `--repo` working tree.

  An unreadable tree fails closed. So does a `git check-ignore` that cannot answer:
  no git, a timeout, or exit 128 inside a repository (a broken `.git`, a "dubious
  ownership" refusal). Git runs with every inherited `GIT_*` variable dropped, so
  `GIT_DIR` or `GIT_WORK_TREE` cannot point it at another repository. Whether the
  tree is inside a repository is decided from the filesystem: a `.git` entry,
  including a dangling symlink, at the root or any directory above it. Outside every
  repository no ignore rule applies.
- on a surface whose **own path is one exact repository file** (S1 review repair). A
  signal reopens a dropped pair only at the exact path of its surface, so a path that
  only looks like the file would silently disable the reopen. The path of every
  surface that lowers a fact follows the citation path rule (no whitespace, no leading
  or trailing slash, no empty segment, not a bare directory name such as `src`,
  `surface_fact_not_lowerable` at select; `plan_block_invalid` when a stored block is
  replayed, so `init` and `preflight` refuse it as `security_pairs_mismatch`). Where
  citations are checked (the list above), the path must also be a **file** with
  **exactly** that case (`citation_missing`): a case alias of an existing path
  (`src/Orders.ts` for `src/orders.ts`) or a directory is refused even inside a DAG
  write; a path that does not exist yet is deferred inside a DAG write (a file the
  change creates) and must exist at review and ship-ready. A surface that lowers no
  fact is not checked: it drops no pair, so its path only places signals.
  Residual: a repository reachable only through `GIT_DIR` or `GIT_WORK_TREE`, with
  no `.git` entry at or above the root, has no ignore rules this check can see. That
  arrangement exists only in the operator's process environment, which the plan
  author and the workers cannot set.
  The check proves that the cited text exists, not that it supports the claim: that
  judgment is the review row (section 9).
- never on every surface (`surface_fact_reinflates`), and never so that a control
  the change selects is left with **no effective pair** (`surface_fact_reinflates`).
  A surface that keeps the fact but whose kind cannot pair the control is no keeper;

- never for a pair whose control is in the signal class of the surface's own path
  (`surface_fact_not_lowerable`), because every reassessment would reopen it.

The evaluator decides each pair separately: a pair is dropped only when its own
control's gate for that kind names the lowered fact(s) and the control, evaluated
again with them false, is no longer selected. A fact lowered for one control never
drops another control whose gate does not name it. Lowering never adds a pair
anywhere. The dropped pairs and the effective pairs together are exactly the pairs
the same facts select without surface facts.

## 4. Running select

```text
node scripts/security-plan.mjs select --facts <file|-> [--catalog <path>]
```

Input: `{ security_policy: 2, surfaces, facts, evidence, summary? }`. Output: the
selected controls and `<boundary>:<control>` pairs, the excluded controls with
reasons, unknown facts, a `config_fragment` (only DAG config keys: `securityPolicy`,
`catalogDigest`, `controlCoverage`), and `rows_md`, the §3a body with the
`security-pairs sha256:<hex>` line and the `<!-- security-plan: {...} -->` machine
block. With surface-level facts the output also has `block_format: 3` and
`na_pairs` (each dropped pair with its lowered facts and citations). The block then
has `policy: 3` and `na_pairs`, and its selection digest covers every surface (facts,
citations, path, principals), the effective pairs and the dropped pairs. The
`security-pairs` line and `controlCoverage` hold the **effective** pairs only. An
engine older than block format 3 refuses such a block outright. A selection without
surface facts is block format 2, byte for byte as before. Exit 0 is a result; exit 2 a refusal (`catalog_missing`, `catalog_invalid`,
`fact_uncited`, `control_unpaired`, ...); exit 1 malformed input. A refusal of your
own input (`fact_uncited`, `control_unpaired`, `fact_out_of_vocabulary`,
`surface_facts_mismatch`, `bad_input`) is corrected and rerun, not a user decision:
cite the fact, pair the control, use the vocabulary or mark the fact
`"unknown: <why>"`. **`catalog_missing` or `catalog_invalid` is `WAIT_FOR_USER`**
with the code; a missing catalog is never an empty selection.
If Node is unavailable the helper is a declared degradation: the plan says so
and treats every `[NN]` control as applying.

## 5. Exclusions, dropped pairs, waivers, NOT_APPLICABLE

Every surface x control cell of an approved plan has exactly one disposition
(section 12). Four of them mean the cell needs no spec. Only one of those four is a
risk acceptance:

| Disposition | Decided by | Meaning |
|---|---|---|
| `excluded-by-change-fact` | the catalog predicate over the change facts | the control is not selected for the change (it is in `excluded[]`), or the kind's gate names only facts that are false for the change |
| `dropped-by-kind` | the catalog's kind-level `not_applicable` reason | the control is selected for the change, but this kind of surface cannot exhibit the attack |
| `dropped-by-fact` | a cited surface-level fact (section 3), approved in the plan | the control's gate for this kind names a fact that is false for this surface |
| `waived` | a trusted `SECURITY_WAIVER` for exactly one candidate | an **effective** pair whose risk the owner accepts; the only risk acceptance |

The fifth disposition, `proven`, is an effective pair: its own RED spec must prove it.
A plan cannot accept risk. A `SECURITY_WAIVER` waives only an effective pair; one that
names a dropped pair is ignored. `NOT_APPLICABLE` in a review row is **not** a waiver.
For an effective pair it is accepted only with a trusted waiver. For a dropped pair it
is the reviewer agreeing with the cited fact (section 9).

## 6. Binding into the DAG

The plan's DAG carries three config keys, none defaulted:
`securityPolicy: 2`, `catalogDigest: "sha256:<hex>"` (the catalog bytes the plan was
approved against) and `controlCoverage: [{ boundary, control, node, specs: [{file,
name}] }]`. The pair id is `<boundary>:<control>`, parsed on the **last colon**
(boundary ids may contain `:`). Each pair has its own named spec(s), never shared
with another pair; the spec file lives inside the node's existing `writes`. A spec
that would sit outside the existing node paths is a contract expansion:
`WAIT_FOR_USER`. A non-empty `controlCoverage` needs a formatted
`config.testCommands` runner, because the proof parses each spec's result. `init`
refuses with `security_policy_required` (post-cutoff run without policy 2),
`security_pairs_mismatch` (the narrative's `security-pairs` line or machine block
does not match the DAG's pairs and digest, or an approved surface path lies outside
every node's `writes`) and `catalog_unavailable` (catalog missing or not the one
approved).

For a block format 3, `controlCoverage` lists the effective pairs only. A dropped
pair has no spec and is not in the DAG; listing it is `security_pairs_mismatch`.
`init` also checks two more things. First, the obligation matrix must verify
(section 12, `disposition_*` or `plan_block_invalid`). Second, every file-shaped DAG
write that raises a surface-introducing signal (test-named or not) must be a
listed surface (`surface_inventory_incomplete`). The run records `policy_version` 3,
or 4 with test kinds. An engine that does not know these versions refuses the run
(`policy_version_unsupported`).

**Preflight, before approval.**
`run-engine.mjs preflight --repo <dir> --ticket <key> --dag <file> [--plan <file>]`
runs these plan checks: `validateEngineDag`, the security binding and, for format 3,
the matrix and inventory. It needs no START or RUN-STATE and writes nothing. Run it
on the draft plan and DAG before `ExitPlanMode`. A refusal prints
`run-engine: <code>: ...` and exits 1. A DAG without `securityPolicy: 2` is refused
`security_policy_required`, because no START approves it.

## 7. Reassessment

`gate reassess` re-evaluates the candidate against the approved plan. Its input is
`{ classifications: [{ signal_id, facts?, evidence?, reason? }], surfaces?: [{ boundary_id,
kind, path, principals[] }] }`. `surfaces` are new or changed boundaries the candidate
introduces inside the Design Contract; `reassess` unites them with the approved block's
surfaces itself, in the gate and in the standalone helper alike, so a new route or auth
surface produces new pairs (`ADD_CONTROLS`, then `addendum_required` until an owner
`SECURITY_ADDENDUM`). An input surface that reuses an approved boundary id with a
different kind, path or principals is refused `bad_input`. No classification, by reason,
by cited facts or both, closes a `new-route`, `auth-or-middleware-change` or
`migration-or-rls-change` signal on a path that is not an approved surface (facts never
add a boundary): it closes only through an input surface at that path whose pairs cover
the signal's control class. On a path that is an approved surface a classification can
close such a signal. That is intended: the owner approved that file as a surface in the
plan, a mechanical signal can be a false alarm, and the classification is recorded and
reviewed. An approved surface counts only at exactly the signal's path. Input `surfaces` are
not stored: every later `gate reassess` call must supply them again, or the signal
reopens (it fails closed). A surface outside the Design Contract is a REAPPROVAL basis
(re-approval re-enters Plan Mode and presents the revised plan with `ExitPlanMode`).

**Proving a pair spec (attribution rule).** Under TAP, a passing test carries no file
location, so a pair spec counts as passed only when the formatted command runs exactly
that one spec file: one non-option argument, a relative path with forward slashes, and
only these options: `--test`, `--test-reporter=tap`, `--test-reporter-destination=stdout`,
`--test-name-pattern=`, `--test-concurrency=`, `--test-timeout=`, `--no-warnings`. Any
other option (`--import=`, `--require=`, `--loader=`, another reporter, an unknown flag)
proves nothing for TAP, and neither does a whole-suite command, a glob, a directory or an
absolute path. A jest or vitest result that carries its file is attributed by it; one
without a file is attributed only under the same rule (exactly one file, only the
options listed above), which a `--json` or `--reporter=json` command does not meet.
Name one
spec file per formatted command in the plan. A same-named test in another file never
discharges a pair. Not covered: a preload set through `NODE_OPTIONS` in the engine's own
environment, which a worker cannot set.

Reassessment runs when the orchestrator calls `gate reassess`, not automatically on
every engine run: at the start of PROVE, after every PROVE or REVIEW repair that
touches mapped files, and fresh before review and before ship-ready. The freshness
check (section 8) makes review and ship-ready fail closed if a call was skipped.
Mechanical signals (a match creates
a signal, never a control): `new-dependency`, `migration-or-rls-change`,
`infra-or-ci-config`, `env-or-secret-reference`, `auth-or-middleware-change`,
`new-route`, `mail-or-notification-send`, `payment-or-stock-or-wallet-call`, plus
`out-of-plan-path`. A signal already covered by the approved pairs of its class
needs nothing. Any other stays open (`reassess_unclassified`) until it is closed: by
a classification, or, for the three surface kinds on a path that is not an approved
surface, only by an input surface at that path (rule above).

| Signal | Control class that covers it |
|---|---|
| `new-route` | `VAPT-API-01`, `VAPT-API-02`, `VAPT-API-03` |
| `auth-or-middleware-change` | `VAPT-API-02`, `VAPT-API-03`, `VAPT-CFG-04`, `VAPT-ABUSE-08` |
| `migration-or-rls-change` | `VAPT-API-01`, `VAPT-ABUSE-07` |
| `mail-or-notification-send` | `VAPT-ABUSE-02`, `VAPT-ABUSE-03` |
| `payment-or-stock-or-wallet-call` | `VAPT-ABUSE-04`, `VAPT-ABUSE-05`, `VAPT-ABUSE-07` |
| `env-or-secret-reference` | `VAPT-CFG-03` |
| `new-dependency`, `infra-or-ci-config` | none: never covered mechanically, always need a classification |

A signal closes through surfaces only when the surfaces at its path, evaluated with
the approved plan's facts, together select every control of that class. Facts raised
by a classification in the same call do not count toward this. Surfaces that select
less leave the signal open (it fails closed): declare the kind that matches the
change, add a second surface at that path of a kind that selects the class, or use
`unknown`, which selects what all the boundary kinds together select. A classification
whose `signal_id` matches no signal is ignored.

| Outcome | Meaning | Next |
|---|---|---|
| `UNCHANGED` | no new pair follows | recorded as `SECURITY_REASSESSED` |
| `ADD_CONTROLS` | new pairs inside the contract | an owner `SECURITY_ADDENDUM` adds them (add-only); `addendum_required` until then |
| `REAPPROVAL` | catalog digest changed or a path outside the contract | new START and plan digest after re-approval through `ExitPlanMode`; `WAIT_FOR_USER`, `drive` stops |

A classification can only raise facts; it can never remove an approved pair.

**Dropped pairs reopen (block format 3).** A dropped pair stays out of the approved
pairs, so reopening it makes it a delta pair (`ADD_CONTROLS`, then
`addendum_required` until an owner `SECURITY_ADDENDUM` adds it with its spec). Two
things reopen it:

- A signal at that surface's path whose class (table above) names the pair's
  control. This happens whether the signal is classified, dismissed by a reason or
  still open: classifying a signal never suppresses a reopen.
- A used classification that raises the lowered fact to `true` or `unknown`. This
  reopens every pair the fact dropped.

Input `surfaces` keep exactly four keys. A surface-level fact is never accepted after
approval, so the orchestrator cannot lower a fact mid-run (`bad_input`). An approved
format-3 block is replayed under the installed catalog at every reassessment. A
lowering that no longer follows from it is `plan_block_invalid`.

**Test files and workspace folders (C5, block format 3 only).** A format-2 run keeps
the original detector byte for byte. This is pinned by
`scripts/security-plan-legacy.golden.json`, captured from be63aea under the catalog
digest the file records.

**The C5 rule (S1 review repair, owner decision: no filename-based exemption).** A
format-3 run uses the format-2 detector, the same signal kinds and the same closure
rule, for every path and line signal. A `new-route`, `auth-or-middleware-change` or
`migration-or-rls-change` signal on a path that is not an approved surface closes only
through a surface at that path, which leads to `ADD_CONTROLS` and then an owner
`SECURITY_ADDENDUM`. A reason never closes it, in either format. There is exactly one
difference, and it only adds signals:

- **Additive route lines.** Format 3 also raises `new-route` on fastify, hono and
  elysia verbs and on one-line tRPC procedures. Nothing relies on it.

**No narrowing, anywhere.** No test name, workspace folder or other path rule removes
a signal, in any consumer of the detector: reassess signals, the plan-time inventory
check at `init` and `preflight`, the own-path lowering guard at selection, and the
reopen of dropped pairs. A test-named file is therefore treated like any other file:

- one that registers a route (`app.post(...)` in `src/orders.test.ts`, `@router.get`
  in `app/routers/test_results.py`) or sits on an auth path (`src/auth.test.ts`,
  `edge-functions/auth.test.ts`, `public/login.test.php`) raises its signal and needs
  a §3a surface, at plan time and at reassess;
- a surface at such a path cannot lower a fact whose control its own path signal
  names (`surface_fact_not_lowerable`), exactly like `src/auth.ts`;
- a test with no route line and no signalling path (only `describe` / `it` /
  `expect`) raises nothing.

A property test pins this (`[S79] [S103]`). Over at least 4000 random inputs of changed
files and lines, plus fixed examples, with lines and path-only: the format-3 signals
are a superset of the format-2 signals for every kind, path-only they are equal, the
only extras are `new-route` route lines, and the plan-time inventory never omits a
format-2 surface signal. Anything format 2 leaves closable only by a surface cannot
reach `reassessed` in format 3 through reason-only classifications. Mutants that
re-add a narrowing (per signal kind, in the lowering guard, in the reopen pass) are
killed by it.

**Accepted friction.** Every file under a folder named `api` (`apps/api/`,
`packages/api/`), test-named or not, raises `new-route` and needs a surface, as on
format 2. So does a test-named file that registers a route or sits on an auth path
anywhere. That is correct for a gate that cannot tell a test from a served file by
name: list the file as a surface. The S2 catalog entries and per-surface facts reduce
the pair cost of such surfaces generically. No exemption record (`c5_exempted`) and
no per-file review row exist: the surface's pairs carry the obligation.

**Approvals made under the old name rule.** A block approved while the name rule
applied can drop a pair on a test-named surface whose own path raises the auth
signal (for example `src/auth.test.ts` lowering `session_context`). The own-path
guard now refuses that lowering, so such a block is `plan_block_invalid` when it is
replayed at the next reassessment (the gates report `security_pairs_mismatch`): it
must be re-selected and re-approved. It never reassesses `UNCHANGED`.

For a format-3 block, a changed path inside the Design Contract that raises one of
the three surface signals under this detector, and has no surface at its path, is
refused `surface_inventory_incomplete` before classification. The same check runs
at `init` and `preflight` over file-shaped DAG writes. Add the surface to the
inventory.

**The LF pin on `controls.json` (side effect).** The catalog digest is the sha256 of
`skills/vapt/controls.json`'s raw bytes. `.gitattributes` now pins that file to LF,
so every OS checks out the same bytes and gets the same digest. Before the pin, a
Windows `core.autocrlf` checkout had CRLF bytes and a different digest. A plan
approved from such a checkout records the old digest, so the pinned catalog refuses
it (`catalog_unavailable`). Re-select and re-approve it.

**Windows coverage.** The engine end-to-end tests in `security-obligations.test.mjs`
(init, preflight, review, confirmation and ship-ready through the real engine) skip
on Windows. POSIX process groups are needed for quiescence (known limit N7). On
Windows, CI runs every pure test of the file:

- selection, block format 3, replay and digests;
- the C5 detector and its superset property test;
- the legacy golden;
- the obligation matrix;
- citation checks;
- row and dispute rules.

The end-to-end paths are covered by the ubuntu and macOS harness legs.

**Follow-ups (not done in S1).**

- **F4, test files that raise a surface signal.** Under the current behaviour
  (accepted friction above), such files need a surface, as on format 2. Any way to
  reduce this friction (for example from the project's own test configuration) is
  pending an owner decision. It is not authorized for implementation, and it may never
  be a filename exemption.

- The legacy golden embeds the catalog digest. A legitimate catalog change fails
  `[S59]`, whose message explains how to regenerate from be63aea's
  `security-plan.mjs` under the new catalog (see the capture helper).
- An original's second-opinion dispute counts only with a `subject_id`. A confirmation
  records no dispute at all (it has no structured way to name one): its `FAIL` is
  terminal for the attempt and the owner decides the `RETRY`.

**What reopening does not cover (residuals, documented).**

- A dropped pair reopens only through a signal at **its surface's own path**, or
  through a classification that raises its fact. A change in another file the
  surface imports reopens nothing by itself.
- Six gated controls have **no signal tripwire**. `VAPT-API-04` (mass assignment),
  `VAPT-WEB-04` (CSRF), `VAPT-ABUSE-01` and `VAPT-ABUSE-06`: no signal class names
  them. `VAPT-CFG-04` and `VAPT-ABUSE-08`: their only signal class is the path-only
  `auth-or-middleware-change` signal, and the own-path guard refuses to drop them on a
  surface whose path raises it, so no signal at a dropping surface's path can name
  them. A later write that makes the dropped fact true again is caught only by the
  mandatory review row of the dropped pair (section 9), on the frozen candidate.
- A surface the candidate adds after approval gets only its effective pairs in the
  matrix (`extra` cells): its other controls have no cell. Its pairs are delta pairs
  and need an addendum, so nothing is dropped, but the matrix is complete only for
  the approved surfaces.
- An open dispute is not a status judgment: `drive` still runs an enqueued repair,
  and the stop shows at the confirmation gate.

## 8. Freshness

The recorded reassessment must match the tuple **candidate_id + approved plan
digest + catalog digest + effective addendum set**. If any part moved, review and
ship-ready refuse `reassess_stale`; a review made under an older catalog or
addendum set refuses `security_review_stale`. `gate ship-ready` makes these checks
twice: before the local proof and again after it, before it records ship-ready, so
a proof command that changes the installed catalog is refused `reassess_stale`. A
proof command that moves `config.base` leaves its pairs unproven (`control_unproven`).

Recovery differs by code:

- `reassess_stale` is cleared by running `gate reassess` again on the current
  candidate. No `RETRY` is needed.
- `security_review_stale` needs an owner `RETRY` and a new independent review,
  never a free refresh.
- A recorded `REAPPROVAL` is permanent for the run: `S.security.reapproval` is never
  cleared, and a new START digest yields `approval_mismatch`. Recovery is a new run
  (re-init) with a new plan.

Any change to the bytes of `controls.json` gives a new catalog digest, which makes
in-flight policy-2 runs stale or `REAPPROVAL` by design. Where the skills auto-update
is installed, an update that carries a catalog change does this mid-run.

## 9. Review coverage

- The primary returns exactly one `rule_row` per effective pair
  (`subject_id: '<boundary>:<control>'`), with evidence from the pair's spec. A
  missing or duplicated pair row is refused with `incomplete_contract`.
- `NOT_APPLICABLE` only for a waived pair (`security_row_escape` otherwise).
- `security_outcome: NOT_TRIGGERED` is rejected while any unwaived pair is
  effective (`security_outcome_escape`).
- Every **dropped** pair (block format 3, not reopened) also needs exactly one row
  (`incomplete_contract`). The row can be:
  - `NOT_APPLICABLE`, agreeing with the cited fact. Its evidence must name a cited
    path (`incomplete_contract` otherwise).
  - `FAIL`, disputing the drop. A second-opinion finding carrying
    `subject_id: '<boundary>:<control>'` of a dropped pair disputes it the same
    way: reconciliation cannot dismiss it.
  - Never `PASS`: no spec proves a dropped pair (`security_row_escape`).
- With every pair dropped or waived, `NOT_TRIGGERED` is accepted, unless a dropped
  pair is disputed (`security_outcome_escape`).
- A **disputed** dropped pair is a hard stop for the whole run. Repair and
  confirmation never clear it, and neither does a later `RETRY` review: the dispute is
  recorded run-wide. Confirmation and `gate ship-ready` refuse it with
  `security_na_disputed` until the pair is effective again. These run-wide, add-only
  disputes come from ORIGINAL reviews only (a primary row `FAIL`, or a second-opinion
  finding with the pair's `subject_id`). A confirmation (shape `{[route,]
  reviewer_identity, candidate_id, checked_findings, outcome, evidence}`) has no
  validated way to name a pair: rows or findings on it are refused
  `incomplete_contract`, and no dispute is read from its evidence text. A
  confirmation `FAIL` is terminal for that review attempt (no repair, no second
  confirmation, ship-ready `review_not_accepted`); its gate output quotes each
  reviewer's outcome and evidence. Proceeding is an owner `RETRY`, an explicit human
  decision made with that FAIL and its evidence on record, followed by a fresh
  original review; a PASS original then ships like any other. Only these make a
  disputed pair
  effective:
  - an owner `SECURITY_ADDENDUM`, after which the pair is proven or waived like any
    pair;
  - re-approval of the plan, which starts a new run.
- Both `[NN]` and `[D]` pairs need a passing spec or a waiver.
- A **skipped spec is not a pass**; `gate ship-ready` adds `control_unproven` per
  pair lacking an accepted RED, an unrewritten spec and a named pass in the proof.
- The effective set is a floor for the primary, not a ceiling for the counterpart:
  it receives the security plan and returns findings only.
- A repair that touches a pair's spec file makes the second opinion required.

## 10. One source of applicability

| Concern | Owner |
|---|---|
| Profile, routing, labels: spine "Security sensitivity", ELEVATED, `HIGH_RISK`, `CONFIRM_SECOND_OPINION` | unchanged; ship-ticket |
| Which attack classes apply to a change | the catalog, via `select` and `reassess` |

A label never invents or removes an attack class.

## 11. Grandfathering

A run whose trusted START was approved before `SECURITY_POLICY_CUTOFF` (in
`engine-dag.mjs`) runs unchanged without policy 2, byte for byte. The START time
is `approved_at`, or `timestamp` when absent; a missing or unparseable time fails
closed. A later run without `securityPolicy: 2` is refused at `init` and
`verifyBinding` with `security_policy_required`.

Events: `SECURITY_ADDENDUM` and `SECURITY_WAIVER` are authority events (see
[ship.md](ship.md)); one appended while dispatched work is live is untrusted and
refused. `SECURITY_REASSESSED` is engine-recorded.

## 12. The obligation matrix

`node scripts/security-plan.mjs obligations --plan <plan.md> --repo <dir> [--addenda <pair ids json>] [--waived <pair ids json>] [--catalog <path>]`
prints the full surface x control matrix of an approved block (format 2 or 3). It
imports no engine module, so it runs in the manual flow too. Each cell is derived
from the block and the catalog independently and gets exactly one of `proven`,
`waived`, `dropped-by-fact` (with the facts and citations), `dropped-by-kind` or
`excluded-by-change-fact` (section 5). The matrix fails closed:

- a cell the block both pairs and drops is `disposition_duplicate`;
- a cell the catalog pairs but the block neither pairs nor drops is
  `disposition_missing`;
- a cell with a value outside the vocabulary is `disposition_unknown`.

There is no `accept_risk` or `structural` disposition. A format-3 `gate ship-ready`
refuses an incomplete matrix and prints the matrix (counts, digest, cells) with its
decision.
