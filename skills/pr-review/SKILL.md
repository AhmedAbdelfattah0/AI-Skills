---
name: pr-review
description: |
  Independent three-pass review of an OPEN pull request — Claude and the OpenAI
  Codex CLI review the same PR diff in separate processes, neither seeing the
  other, and a rule-by-rule Verification Pass from the code-quality family
  (`NG-*` / `BE-*`) catches what free-form review misses because nobody thought
  to look. Findings are reconciled into one attributed comment set. Takes
  a PR URL or ID; supports GitHub (`gh`) and Azure DevOps (MCP). Fetches the PR
  into a throwaway git worktree — or a temp clone when the PR lives in another
  repo — so the user's checkout, branch, and uncommitted work are never
  touched. Report-first: writes
  `.specs/pr-review/<host>-<id>.md` and posts comments to the PR only after
  explicit approval.

  Trigger when the user:
  - types /pr-review, /pr.review, or /review-pr
  - says "review this PR", "review PR 128", "code review this pull request",
    "do an independent review of this PR", or "what's wrong with this PR"
  - pastes a GitHub or Azure DevOps pull-request URL and asks for a review
  - asks for a second opinion on someone else's PR before approving it

  Do NOT use for: the local uncommitted diff before a PR exists (use
  /code-review, or ship-ticket's own review passes), whole-codebase security
  work (security-audit), runtime exploit testing (vapt), or writing the code
  the PR should have contained (this skill reviews, it does not implement).
---

# PR Review — three passes, one diff, none sees the others

A model reviewing a diff it has already summarized finds what it already
believed. The value here is **independence**: two different models, in two
different processes, read the same PR with no knowledge of each other's
findings, and only then does one head — yours — reconcile them.

But two free-form reviewers still only find what they happen to notice, and the
worst defects are **absences** — the ownership check nobody wrote, so nothing in
the diff looks wrong. So a third pass walks a numbered rule list and fills in a
row per rule, where an absence surfaces as an empty box instead of as silence.

| Pass | Method | Catches |
|---|---|---|
| **A — Claude** | free-form, fresh reviewer | what a careful reader notices |
| **B — Codex** | free-form, different model + process | what a *different* model notices |
| **C — Verification** | rule-by-rule, `NG-*` / `BE-*` | what nobody thought to check |

That structure is the skill. Everything else (worktree, refs, posting) is
plumbing that exists to protect it.

**Three rules that never bend:**

1. **The user's checkout is never touched.** No `gh pr checkout`, no branch
   switch, no stash, no reset in the working clone. The user may have hours of
   uncommitted work; a review that moves their `HEAD` is a bug, not a review.
   The one thing this skill writes into their repo is **temporary refs in a
   `pr-review-*` namespace** (a worktree and a pinned base branch), all removed
   at cleanup — and if a name is already taken, it picks another rather than
   overwriting, because `git branch -f` on a name that turns out to be theirs
   destroys a real branch.
2. **No pass sees another pass's output.** Not in a prompt, not as "context",
   not as a follow-up question. The moment they share findings, you have one
   pass with extra steps.
3. **Nothing is posted to the PR without explicit approval.** A PR comment is
   public and addressed to another person. Report first, post on confirmation.

## What this is not

| Use instead | When |
|---|---|
| `/code-review` (CodeRabbit) | The diff is local and there is no PR yet. Also this skill's declared fallback engine when the `codex` CLI is unavailable. |
| `ship-ticket` steps 13–14 | You are *implementing* a ticket and want the pre-PR review passes as part of that workflow. |
| `security-audit` | You want the whole codebase read for vulnerabilities, not one diff. |
| `vapt` | You want the change **attacked at runtime**, not read. A PR review reads; it never proves a control engages. |

This skill reviews. It does not fix, does not push, and does not approve.

---

## STEP 1 — Resolve the PR

The argument is a URL or a bare ID. Resolve host, repo, and number **before**
anything else; a wrong guess here reviews the wrong diff.

| Argument form | Host | Resolution |
|---|---|---|
| `https://github.com/<owner>/<repo>/pull/<n>` | GitHub | owner, repo, and number straight from the URL |
| `https://dev.azure.com/<org>/<project>/_git/<repo>/pullrequest/<n>` | Azure DevOps | org / project / repo / number from the path |
| `https://<org>.visualstudio.com/<project>/_git/<repo>/pullrequest/<n>` | Azure DevOps (legacy host) | same |
| bare `128`, `#128`, `PR 128` | **infer** | `git remote get-url origin` → `github.com` ⇒ GitHub; `dev.azure.com` / `visualstudio.com` ⇒ ADO |

**If the bare ID cannot be resolved to exactly one host — no git remote, a
remote on neither host, or several remotes disagreeing — STOP and ask.** Do not
try both hosts and take whichever returns something; PR `128` almost certainly
exists on both, and reviewing the wrong one wastes the whole run.

Then fetch the PR's metadata — you need its **intent**, not just its diff:

```bash
# GitHub
gh pr view <n> --repo <owner>/<repo> --json \
  number,title,body,state,isDraft,author,url,baseRefName,headRefName,headRefOid,files,additions,deletions
```

For Azure DevOps use the `repo_pull_request` MCP tool, `action: "get"`, with
`includeChangedFiles: true` and `includeWorkItemRefs: true` (pass `project` when
`repositoryId` is a name rather than a GUID).

**Read the description and any linked work item before reviewing.** A review
that does not know what the PR *claims* to do can only find generic defects —
it cannot find the one that matters most, which is "this does not do what it
says". If the PR body is empty and no work item is linked, say so in the report:
the review ran without an intent to check the diff against.

**State checks — report, do not silently proceed:**

- **Draft PR** — fine to review; note it (the author is not asking yet).
- **Closed or merged** — the diff still reviews cleanly, but comments may be
  pointless. Say so and ask whether to continue.
- **Auth failure** (`gh auth status` fails, MCP returns 401/403) — STOP. Tell
  the user the exact command that failed; `gh auth login` is their action, not
  yours.

## STEP 2 — Availability check (binaries, not the skill list)

Check **once, up front**, and declare the run's mode before reviewing. A gate
whose engine is missing **degrades loudly, never silently** — a run that
quietly dropped a pass is indistinguishable from one that ran it.

A companion **skill** is available if it is in the available-skills list. A
companion **CLI** is available only if the binary answers. Never use the skill
test on a binary.

| Engine | Check | If missing — declared fallback |
|---|---|---|
| Codex (pass B) | `codex --version` succeeds | Fall back to `/code-review` (CodeRabbit) on the same worktree diff — same slot, different engine. If neither exists the run loses pass B and goes **two-pass (A + C)**; say so in the report header and in the terminal summary. Never substitute a second free-form Claude pass and call it independent — pass C is not that substitute, it fills a different slot (rule-by-rule, not free-form). |
| `gh` (GitHub PRs) | `gh --version` **and** `gh auth status` | STOP for GitHub PRs — the diff cannot be fetched. |
| ADO MCP (`repo_pull_request`) | tool present and returns the PR | STOP for ADO PRs. |
| code-quality family (`angular-code-quality` / `backend-code-quality`) | skill list | **Owns pass C** (step 6) and the rule vocabulary passes A and B report in. **Fall back to the `code-quality` hub** — it covers any language and still yields a rule-backed pass. With **no** family member installed, pass C degrades to the universal principles + AI failure modes with **no rule IDs**, which also disables the citation route for dropping findings (step 8). Declare it. |
| `test-quality` / `docs-accuracy` | skill list | Drop the `TEST` / `DOC` rows from pass C and the matching lenses from A and B; note the skip. |

An installed-but-unauthenticated CLI fails at dispatch rather than at the check.
When that happens, treat it as the same degradation and declare it then.

**Declare the mode in three places:** up front when detected, in the report
header, and in the terminal summary.

## STEP 3 — Materialize the PR without touching the checkout

**First: does this PR even belong to the repo you are standing in?** A pasted
URL usually points at *another* repository — that is the normal case for
reviewing someone else's work. Never assume `origin` is the right remote; PR
`128` almost certainly exists in both repos, and `origin` would review the wrong
one.

```bash
# The remote resolved in step 1 — not necessarily this checkout's origin.
PR_REMOTE="https://github.com/<owner>/<repo>.git"      # or the ADO clone URL
ORIGIN=$(git remote get-url origin 2>/dev/null)
```

Compare `PR_REMOTE` against `ORIGIN` (ignore `.git`, protocol, and SSH-vs-HTTPS
differences — `git@github.com:o/r.git` and `https://github.com/o/r` are the same
repo) and take the matching route:

| Case | Route |
|---|---|
| **Same repo** | `git worktree` off the current clone — cheap, shares the object store, nothing to download twice. |
| **Different repo**, or no git repo here at all | **Clone it to a temp dir instead:** `git clone --filter=blob:none <PR_REMOTE> "$WT"` (or `gh repo clone`). Do **not** fetch a foreign repo's refs into the user's clone — those objects persist after the refs are deleted, silently bloating their repo. |

Everything below uses `"$WT"` as the review tree and `$PR_REMOTE` as the fetch
source, so the two routes converge from here.

```bash
WT="$(mktemp -d)/pr-<n>"
```

**Discover the PR ref — do not assume it.** Ref layout differs by host and some
servers publish only one of the two:

```bash
git ls-remote "$PR_REMOTE" 'refs/pull/*' | grep -E "refs/pull/<n>/"
```

- **GitHub** publishes `refs/pull/<n>/head` (the PR's own tip — what you want).
- **Azure DevOps** publishes `refs/pull/<n>/merge` (a server-computed merge
  commit) and often no `/head`.
- **If neither resolves**, fall back to fetching the source branch by name from
  the metadata (`headRefName` on GitHub, `sourceRefName` on ADO). If that also
  fails — a fork PR on a host without pull refs — STOP and say the diff is not
  reachable from this remote.

**Take the base from the PR, not from the base branch's current tip.** The API
pins the commit the PR is actually compared against — `base.sha` on GitHub
(`gh api repos/<owner>/<repo>/pulls/<n> --jq .base.sha`, equivalently
`baseRefOid`), `lastMergeTargetCommit.commitId` on ADO. Fetch **that SHA**, then
take the merge-base with the PR head:

```bash
# Same-repo route (worktree). For the clone route, run the fetches inside "$WT"
# against origin, which is already $PR_REMOTE, and skip the worktree add.
git fetch "$PR_REMOTE" 'refs/pull/<n>/head:refs/pr-review/<n>'  # or the /merge ref
git fetch "$PR_REMOTE" '<base-sha>'                             # the pinned SHA, not the branch
git worktree add --detach "$WT" "refs/pr-review/<n>"
BASE=$(git -C "$WT" merge-base '<base-sha>' HEAD)

# Pin the base as a real local branch — the Codex harness route needs a branch
# name, and this keeps every pass on the same base (step 5).
git -C "$WT" branch -f "pr-review-base-<n>" "$BASE"

git -C "$WT" diff "$BASE"...HEAD --name-only                    # this is the PR's diff
```

**Why the pinned SHA and not the branch:** diffing against the *current* tip of
the base branch attributes every commit merged since the PR opened to this
author — you would report findings on code they never wrote, in someone else's
PR. Worse, for a **merged or closed PR the head is already an ancestor of the
branch tip, so `merge-base(tip, head) == head` and the diff comes back empty** —
a review that finds nothing because it was handed nothing, which reads exactly
like a clean PR. The pinned base SHA is correct in both cases.

**If the computed diff is empty, STOP** — it is a resolution failure, not a
verdict. Re-resolve the base before reviewing anything.

Fetching a **SHA** rather than a branch name is also what makes this work in
every clone shape: `git fetch <remote> <branch>` writes only `FETCH_HEAD` and
merely *opportunistically* updates the remote-tracking ref, so
`origin/<base-branch>` may be stale — or, in a `--single-branch` or fork clone,
absent entirely. (If the server refuses to serve an arbitrary SHA —
`uploadpack.allowReachableSHA1InWant` disabled — fall back to fetching the base
branch into an explicit ref,
`git fetch "$PR_REMOTE" '<base-branch>:refs/pr-review/base-<n>'`, and note that a
merged PR then needs the empty-diff check above.)

**Verify the fetched diff equals the PR before reviewing it:**

```bash
git -C "$WT" diff "$BASE"...HEAD --name-only
```

Compare that list against the changed files in the PR metadata from step 1.
**A mismatch means the wrong ref was fetched — STOP and re-resolve.** On ADO the
`/merge` ref legitimately carries the merge result, so a small superset can be
correct; a *different* set is not.

**Cleanup is mandatory, including on failure.** Run it before you report, and
after any early STOP:

```bash
# Same-repo (worktree) route:
git worktree remove --force "$WT"
git branch -D "pr-review-base-<n>"
git update-ref -d "refs/pr-review/<n>"
git update-ref -d "refs/pr-review/base-<n>"   # only exists on the fallback path
git worktree prune

# Clone route: the whole tree is disposable.
rm -rf "$WT"
```

A left-behind worktree quietly pins objects and clutters `git worktree list` in
the user's repo forever, and a left-behind `pr-review-base-*` branch shows up in
their branch list and tab-completion.

## STEP 4 — Pass A: Claude, with no build context

Run the review as a **fresh reviewer subagent** pointed at the worktree. The
independence that matters is *who reviews*: a reviewer that inherits this
conversation inherits its assumptions about what the diff means.

**Start all three passes together.** They are independent by construction, so
dispatch this subagent, background the Codex run (step 5), and dispatch the
Verification Pass (step 6) before waiting on any of them — a PR review is three
multi-minute runs, and serializing them triples the wait for no benefit.
Independence is what forbids sharing findings, not what forbids running at the
same time.

**What the reviewer gets:** the worktree path, `$BASE`, the PR title,
description, and linked work item, the detected stack, and the rule vocabulary
of whichever code-quality family member the stack routes to (`NG-*` for Angular
frontends, `BE-*` for any backend in any language, the `code-quality` hub
otherwise; `TEST-*` for test files, `DOC-*` for docs).

**What the reviewer never gets:** Codex's findings, your opinion of the PR, or
any summary of the diff written by you. It reads the diff itself.

**The finding contract — enforce it on the way out, not just on the way in:**

- severity (**blocker** / **major** / **minor**)
- `path:line`, **repo-relative** — never the worktree's absolute path
- the **quoted line** the finding is about
- the concrete **fix shape** (what to change, not "consider improving this")

Reject and drop anything that is prose-only, cannot be anchored to a line in the
diff, or restates what the code obviously does. Style preferences the repo does
not enforce are not findings.

**Judge the diff against the PR's stated intent**, in this order: does it do
what it claims; does it break something it touches; is it safe; is it correct
under edge cases; is it maintainable. Scope creep — changes the description
never mentions — is a finding.

## STEP 5 — Pass B: Codex, in its own process

`codex review` runs read-only in its own sandbox, which is why it is the second
engine and not a second opinion from the same head.

**The CLI constraint, verified on `codex-cli 0.145.0`:** `codex review` accepts
a **scope flag or a custom prompt, never both** — `--uncommitted`, `--base`, and
`--commit` each conflict with `[PROMPT]` (including the `-` stdin form) and the
command exits on argument parsing. Re-check with `codex review --help` if the
installed version differs; treat the flag table there as authoritative over this
paragraph.

That leaves two routes. **Default to the instructed one** — the PR's acceptance
criteria and scope list are most of what makes this a review of *this* PR:

```bash
# Instructed route (default) — no scope flag, so scope goes in the prompt.
# Run from the worktree, in the background: reviews take minutes and a
# foreground shell call is capped at 10.
cd "$WT" && codex review "<instructions>"
```

The instructions must carry, explicitly:

- **the exact diff command** — "review exactly the diff produced by
  `git diff <BASE>...HEAD` in this worktree, and nothing else". This is what
  makes a *clean* worktree reviewable: with no scope flag the CLI computes no
  diff for you, and `git status` here is empty. Verified on 0.145.0 — given the
  command, Codex ran exactly it and reported all 12 changed files of the test
  PR against the contract below.
- the PR's **title, description, and acceptance criteria** — Codex has no memory
  of this conversation and sees only your text plus the tree.
- the **rule vocabulary** (`NG-*` / `BE-*` / `TEST-*` / `DOC-*`) so its findings
  land in the same language as pass A's.
- the **same finding contract** as step 4: severity, `path:line`, quoted line,
  fix shape; no prose-only findings.
- **repo-relative paths.** Codex reports paths as it sees them — absolute, under
  the temp worktree. Ask for relative paths, **and strip the worktree prefix
  yourself anyway**: a comment posted with `/private/var/folders/.../pr-128/src/a.ts:44`
  is unusable to the PR author.

```bash
# Harness route (alternative) — purpose-built review, zero custom instructions.
# --base takes the PINNED local branch from step 3, never the base branch name:
# the branch tip has moved on, and for a merged PR it yields an empty diff.
cd "$WT" && codex review --base "pr-review-base-<n>"
```

Use the harness route when the PR carries no acceptance criteria worth passing
in, or as a second Codex opinion on a diff whose scope you want the CLI itself
to compute. It cannot be told about the ticket, so it cannot judge intent — and
because it takes no instructions, **it does not honor the finding contract**:
on 0.145.0 it returns its own `[P1]`/`[P2]` priority labels with a path range
and prose, and no quoted line. Normalize those into the contract during step 8
(map `P1`→blocker/major by impact, `P2`→major/minor) and **fetch the quoted line
yourself** from the worktree. The instructed route honors the contract as
written, which is the other reason it is the default.

**Codex loads its own installed skills.** A review prompt matches review skills
in `~/.agents/skills` — including *this* one and CodeRabbit's `code-review` —
and Codex will read them before starting. It is harmless but not free: it costs
context and nudges Codex toward this skill's framing, which slightly erodes the
independence the pass exists for. Add "do not load other skills; review the diff
directly" to the instructions when you want the engine's own judgment
uncontaminated.

**Read the whole output, not the tail.** The run prints its full transcript;
the report is the final block, and on 0.145.0 **both routes print that final
block twice** — deduplicate before parsing or every finding lands in the report
in duplicate. Codex's findings get no special deference for being external and
no discount for being from another vendor.

## STEP 6 — Pass C: the rule-by-rule Verification Pass

Passes A and B are **free-form**: each reports what it noticed, so coverage
follows attention. This pass is the opposite — it walks a numbered rule list and
emits **one row per rule**, so a check nobody thought to perform shows up as an
empty box instead of as silence.

That is what it buys, and it is not the same thing as a third opinion. A PR adds
`GET /invoices/:id`; both free-form reviewers spend their attention on naming,
error handling, and a missing test, and neither asks whether the invoice belongs
to the caller. The defect is an **absence**, and absences do not attract
attention. `BE-SEC-09` has a row that must be filled in.

**Be honest about what this pass is not:** it runs on the same model as pass A,
so it adds *method* diversity, not *model* diversity. Never report it as a third
independent opinion.

**Invoke the specialist the PR's stack routes to** — `angular-code-quality`
(`NG-*`) for an Angular frontend, `backend-code-quality` (`BE-*`) for a backend
in any language, the `code-quality` hub otherwise — and run **its** Verification
Pass over the changed files, from the worktree. Dispatch it as its own subagent
alongside A and B; it is blind to their findings like everything else here.

**The rule set in force comes from the diff, because there is no Design
Contract.** The specialists scope their pass to "the rules the Design Contract
named, plus every `[NN]` rule" — but a Design Contract is an artifact of
*building* something, and this skill reviews work someone else already built.
Derive the set instead:

- **every `[NN]` rule** — always in force, exactly as in the specialists.
- **every rule whose surface the diff touches** — a route handler or middleware
  pulls in `BE-SEC-*` / `BE-AUTH-*` / `BE-TEN-*`; a component or template pulls
  in the `NG-*` architecture and UI rules; a migration pulls in the audit and
  tenancy rules.
- **one `AI-FM` row, always** — walk the 15 LLM failure modes + The Floor
  (`../code-quality/references/ai-failure-modes.md`; if that file is absent,
  walk them from memory: no catch-all error swallowing, no impossible-case
  guards, no mock-success returns, no speculative flags, verify imports exist,
  refactors preserve behavior).
- **a `TEST` row when the diff touches tests** (`test-quality`, `TEST-01..12`)
  and a **`DOC` row when it touches docs** (`docs-accuracy`, `DOC-*`).

Emit the table exactly as the specialist defines it — evidence is a path, a
line, or a clause, never the word "yes":

```
VERIFICATION
| Rule | Status | Evidence |
|---|---|---|
| BE-SEC-09 | FAIL | routes/invoices.ts:22 — no owner check before returning the row |
| BE-TEN-02 | PASS | tenant read from JWT claim at middleware/auth.ts:31 |
| BE-HDR-05 | N/A  | no infra changed in this PR |
| AI-FM     | PASS | no catch-alls, no mock returns, imports verified |
```

**Two rules from the specialists survive; one does not.**

- **N/A requires a reason.** "Not applicable" with no clause is a skipped check
  wearing a status — the exact failure this pass exists to prevent.
- **A row may not be omitted.** If a rule is in force it appears, even to say
  `N/A`. An absent row is the empty box going unnoticed again.
- **"Any FAIL blocks done" does not apply here** — this skill ships nothing.
  A FAIL is not a gate, it becomes a **finding**: rule ID, `path:line`, quoted
  line, fix shape, carried into step 8 attributed `[rules]`. An `[NN]` FAIL is
  a **blocker** and is stated in plain language, not left as a table row.

**If no family member is installed**, this pass degrades rather than
disappearing: walk `../code-quality/references/universal-principles.md` and the
AI failure modes against the diff (fallback if absent: SOLID, DRY, KISS, YAGNI,
plus the failure-mode list above), and state in the report that pass C carried
**no rule IDs** — which, per step 8, means nothing may be dropped by citation.

## STEP 7 — Coverage check (verify, do not assume)

For each pass, compare the files it says it reviewed against
`git -C "$WT" diff "$BASE"...HEAD --name-only`.

A pass that reviewed a subset **covered nothing** on the rest. Re-run it against
the missing paths and treat the union as that pass. Record per-pass coverage in
the report — "Codex: 4/4 files; Claude: 4/4 files" — because a pass with
unstated partial coverage reads exactly like a clean pass.

**Pass C's coverage is measured in rules, not just files.** Check that every
rule you derived as in force has a row, and that no row says `N/A` without a
reason. A short table is the same failure as a short file list: it looks like a
clean result and is actually an unrun check.

**Large PRs split, they do not truncate.** When the diff is too big for one
pass to hold, partition it by directory or subsystem and run that engine once
per partition, then union the findings — never let an engine silently review the
first *n* files. Generated files, lockfiles, and vendored trees may be excluded
from review, but only **explicitly**, listed in the report's *Not reviewed*
section.

## STEP 8 — Reconcile — your judgment, not theirs

All three passes have now reported, independently. This step is the only one
that sees them together.

1. **Deduplicate by defect, not by wording.** Same file, same line, same root
   cause = one finding with several attributions.
2. **Attribute every finding** — `[claude]`, `[codex]`, `[rules]`, or a
   combination (`[claude+rules]`). Agreement between the two free-form engines
   is evidence, not proof: two models trained on similar code share failure
   modes, and both can be confidently wrong about the same line. A `[rules]`
   finding carries its **rule ID**, which is stronger than agreement — it points
   at a written rule the reader can go check.
3. **Verify every blocker against the file in the worktree before it survives.**
   Open the line. Confirm the defect is real and the quoted code is accurate. An
   unverified blocker posted to someone else's PR costs them more than a missed
   one costs you.
4. **Disagreements are a finding of their own** — where one engine flags what
   another explicitly cleared, surface both positions and rule on it. Never
   average them into a softer finding.
5. **Dropping a finding requires a contract failure or a citation.** Two ways
   out, and no third:
   - it **fails the finding contract** — no anchor, no quote, no nameable fix.
     Say how many went this way.
   - it **conflicts with a named rule you cite by ID**:
     `drop: conflicts with NG-STD-06 — signal two-way binding is valid for
     single-value inputs with no validation graph`.

   **A bare category is not a citation.** "Style-only", "pre-existing", "matches
   their conventions" can each be written about any finding, which is exactly
   why none of them may retire one. If you reach for the rule and it doesn't
   actually say what you need it to say, the finding was right. With **no rule
   IDs loaded** (degraded pass C), the citation route is unavailable — every
   contract-passing finding stands.
   (The library-wide statement of this protocol lives at
   `../code-quality/references/review-standard.md`; if that file is absent, the
   two paragraphs above are the whole rule.)
6. **A finding that contradicts an `[NN]` rule is never dropped.** If a reviewer
   and an `[NN]` rule disagree, the reviewer is almost certainly right and the
   PR has a real problem. Surface it as a blocker in plain language.

| Severity | Qualifies |
|---|---|
| **blocker** | Wrong behavior, data loss, a security or authorization hole, a break in something the diff touches, or a claim in the PR description the diff does not deliver. |
| **major** | Real defect under a reachable edge case, missing error handling on a path that can fail, a test that asserts nothing, a documented behavior the diff silently changed. |
| **minor** | Genuine but low-cost: naming, duplication, a missing guard on an unreachable path. Anchored and fixable, or it is not a finding. |

**Neither engine approves, and neither do you.** This skill produces findings;
approving a PR is a human act. Never run `gh pr review --approve` or
`--request-changes`, and never set an ADO vote — not even when both passes come
back clean.

## STEP 9 — Report artifact

Write `.specs/pr-review/<host>-<id>.md` (the repo's spec-artifact root — never
introduce a second one), then summarize in the terminal. The terminal gets the
header, the blockers, and the counts; the file gets everything.

```markdown
# PR review — <host> #<id>: <title>

- **PR:** <url> · **author:** <author> · **state:** <open|draft|merged>
- **Base → head:** <base-branch> ← <head-branch> (merge-base `<BASE-sha>`)
- **Files:** <n> changed (+<add>/−<del>)
- **Passes:** A Claude (<coverage>) · B <codex <version> | CodeRabbit | NOT RUN> (<coverage>) · C <specialist name, rule set | degraded — no rule IDs>
- **Mode:** <full | degraded: …> — <what was missing and what it cost>
- **Intent checked against:** <PR description | linked work item | NONE — review ran without stated intent>

## Verification (pass C)
| Rule | Status | Evidence |
|---|---|---|
| BE-SEC-09 | FAIL | routes/invoices.ts:22 — no owner check before returning the row |
| BE-TEN-02 | PASS | tenant read from JWT claim at middleware/auth.ts:31 |
| BE-HDR-05 | N/A  | no infra changed in this PR |
| AI-FM     | PASS | no catch-alls, no mock returns, imports verified |

<every rule in force appears; N/A carries a reason; each FAIL also appears below as a finding>

## Blockers
### 1. <one-line defect> `[claude+codex]`
`path/to/file.ts:44` — blocker
```<lang>
<the quoted line>
```
<why it is wrong> · **Fix:** <the concrete change>

### 2. <one-line defect> `[rules: BE-SEC-09]`
<same shape — a rules finding names the rule it failed>

## Major
## Minor

## Pass disagreements
<finding · what Claude said · what Codex said · what the rule table said · your ruling and why>

## Dropped findings
<count> dropped — <n> failed the finding contract (unanchored / no fix), and each
citation-dropped finding listed in full: `drop: conflicts with <RULE-ID> — <reason>`.

## Not reviewed
<paths excluded from any pass, and why — or "none">
```

## STEP 10 — Post to the PR (only after explicit approval)

**Never post as a side effect of reviewing.** Show the exact comment set you
propose — text and anchor per comment — and ask. Post only what is approved; if
the user approves a subset, post that subset.

```bash
# GitHub — summary comment
gh pr comment <n> --repo <owner>/<repo> --body-file <report-or-summary>

# GitHub — inline comment on a diff line (commit_id = headRefOid from step 1)
gh api --method POST repos/<owner>/<repo>/pulls/<n>/comments \
  -f body='<finding>' -f commit_id='<headRefOid>' -f path='<repo-relative path>' \
  -F line=<line> -f side='RIGHT'
```

For Azure DevOps use `repo_pull_request_thread_write`, `action: "create"`, with
`content`, `filePath`, and `rightFileStartLine` (plus `project` when
`repositoryId` is a name). Reply into an existing thread with
`action: "reply"` + `threadId` rather than opening a duplicate.

**Posting rules:**

- One thread per finding, anchored to the line it is about. A wall of findings
  in a single comment is unactionable.
- **Repo-relative paths only** — verify no worktree prefix survived into a
  comment body or anchor.
- Blockers and majors get inline threads; minors may ride in the summary
  comment.
- Say which pass found what if it is useful to the author — and a `[rules]`
  finding always names its rule ID, which is the most useful attribution there
  is. Never present a
  finding as more certain than step 8 established.
- **Never** approve, request changes, vote, merge, close, or push a commit to
  the PR branch.
- If posting partially fails (a line no longer exists in the diff, a rate
  limit), report exactly which comments landed and which did not. Do not retry
  silently into duplicates.

---

## Anti-patterns

- **`gh pr checkout` in the user's clone.** Moves their `HEAD`. The worktree
  exists precisely so this never happens.
- **Diffing against the base branch tip** instead of the merge-base — reports
  other people's commits as this PR's.
- **Letting the passes see each other.** Passing pass A's findings to Codex
  "for verification" collapses two passes into one.
- **Posting unverified blockers.** Step 8's verification is not optional
  polish; it is what makes the comment safe to send to another person.
- **Treating agreement as correctness.** `[claude+codex]` raises confidence; it
  does not discharge the check.
- **A short verification table.** Dropping rules that felt irrelevant, or
  writing `N/A` with no reason, converts pass C back into the free-form review
  it exists to complement — and does it invisibly, since a short clean table
  looks exactly like a thorough one.
- **Dropping a finding on a category.** "Style-only" and "pre-existing" can be
  said of any finding; only a named rule ID retires one.
- **Reviewing without the PR description**, then reporting only generic
  defects — the review cannot see the failure that matters most.
- **Leaving the worktree behind.** Cleanup runs on every exit path, including
  STOPs.
- **Silently skipping a pass.** A missing `codex`, an absent specialist — each
  is declared up front, in the report header, and in the summary. An undeclared
  skip makes a two-pass run indistinguishable from a three-pass one.
