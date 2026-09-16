# AGENTS.md

Canonical instructions for any coding agent working in this repository — Claude
Code, Codex, Gemini, or anything else that reads a repo-level guidance file.

This file is agent-neutral on purpose. `SKILL.md` is an open standard consumed by
several tools (see `install --target`), so the repository's own instructions
should not be branded to one of them. `CLAUDE.md` is a pointer to this file; do
not duplicate content between them — the two hand-maintained copies that preceded
this had already drifted by 76 lines.

## What this repo is

Single source of truth for a personal Claude Code **skill library**. Each skill is a folder
`skills/<name>/` containing a `SKILL.md` (plus optional `references/` and `scripts/`). The repo is
**symlinked into the agent's skills directory** (via `install.sh`) — `~/.claude/skills` for
Claude Code, `~/.agents/skills` for Codex, `~/.gemini/skills` for Gemini — so editing a `SKILL.md`
here makes it live immediately — the "update" and "backup" loops are the same `git commit`. There is no
application to build or run; the artifacts are the skills themselves.

## Commands

`scripts/cli.mjs` (the `ai-skills` bin, dependency-free Node) is the **canonical, cross-platform** tool —
it works on Windows/macOS/Linux and is what CI runs. The bash scripts are Unix-only alternatives.

```bash
node scripts/cli.mjs list                 # list every skill + its description
node scripts/cli.mjs validate             # lint every skill; this IS the CI gate (see invariants below)
node scripts/cli.mjs install              # install ALL skills into ~/.claude/skills
node scripts/cli.mjs install <a> <b>      # install only the named skill(s)
node scripts/cli.mjs install --copy       # real files instead of symlinks (or --link to force links)
node scripts/cli.mjs install --target codex|gemini|agents|antigravity|all   # other AI tools
                                          # (SKILL.md is an open standard; codex/agents →
                                          # ~/.agents/skills, gemini → ~/.gemini/skills,
                                          # antigravity → ~/.gemini/antigravity/skills);
                                          # --dest <path> for custom dirs
node scripts/cli.mjs update               # refresh the source, then re-sync what it installed
node scripts/cli.mjs update --check       # report what would change; write nothing
node scripts/cli.mjs update --prune       # also drop skills that no longer exist upstream
node scripts/cli.mjs update --force       # overwrite a copy WE installed that you edited since
node scripts/cli.mjs update --adopt       # take over a directory nobody recorded installing
node scripts/cli.mjs update --auto        # the unattended run: locked, throttled, silent, timid
node scripts/cli.mjs autoupdate           # is automatic updating on? what ran last?
node scripts/cli.mjs autoupdate --install # daily job + Claude Code SessionStart hook
node scripts/cli.mjs autoupdate --remove  # take both back out

# Bash alternatives (macOS/Linux/Git Bash/WSL):
./install.sh                              # root-level curl bootstrap (clone + install + autoupdate)
./scripts/install.sh [--copy] [--target <t,..>|--dest <path>] [names...]  # full mirror of cli install
./scripts/validate.sh                     # thin bash wrapper around the Node validator
./scripts/package.sh [<name>]             # build dist/<name>.skill zips (needs python3)
./scripts/import.sh [--force]             # fold an externally-installed skill back into the repo
```

- **`update` is the equivalent of `claude update` / `codex --upgrade`, for skills.** It refreshes the
  source, then re-syncs every skill it installed — and the three install shapes get three different
  answers, classified from the filesystem rather than assumed:
  - a **symlink into this repo** is already live, so the source refresh *was* its update;
  - a **symlink elsewhere** belongs to another checkout and is reported, never touched;
  - a **copy** is refreshed — unless it differs from what was installed, which means you edited it,
    and it is left alone until you pass `--force`.
  The source refresh is deliberately narrow: `git pull --ff-only`, only from a clean tree with an
  upstream, and every other case (dirty, no upstream, diverged, not a clone) reports why it stopped and
  then re-syncs from the checkout as it stands. An `update` has no business stashing, rebasing, or
  discarding your work. Via `npx github:…` there is nothing to pull — npm re-resolves the GitHub spec
  to `origin/HEAD` on every run, so that path is always already fresh.
- **Three outcomes, three flags — and they are deliberately not one.** A copy we
  installed and you have not touched is refreshed with no flag. A copy we installed
  that you have since edited needs `--force`. A directory that merely shares a name
  with one of our skills, which no manifest records us installing, needs `--adopt`.
  Collapsing the last two into `--force` meant "force an update" silently claimed
  arbitrary same-named content belonging to somebody else.
- **A manifest is only trusted when it came from THIS library.** Install records the
  normalised `git remote origin` alongside the path; `sameLibrary()` compares it, and
  a mismatch makes every record in that directory foreign. Without it, checkout B
  reads checkout A's hashes, concludes "unchanged", and overwrites A's content with
  no flag at all — a fork or a stale branch quietly wins. A manifest predating the
  field falls back to the recorded source path.
- **Install and update both build-then-swap, never destroy-then-write.** `applySkill`
  stages a complete copy under `<dest>/.ai-skills-tmp/`, renames the old aside,
  promotes the staged one, and only then drops the backup; any failure rolls back.
  Deleting first meant a full disk or an interrupt left no skill at all, and the
  catch had nothing to restore from. The staging directory is a DOT-directory
  because a sibling named `security.new` holds a `SKILL.md` and would be scanned as
  a skill of its own while it exists.
- **Provenance lives in `<skills-dir>/.ai-skills-manifest.json`,** written by `install` and updated by
  `update`: source path, commit, mode, and a content hash per copied skill. That hash is the only thing
  that can tell a **stale** skill from one you **edited in place** — byte-level twins with opposite
  correct answers. It is a dotfile, not a directory, so no skill scanner (they look for
  `<dir>/SKILL.md`) ever sees it. `install.sh` does **not** write one; a copy install made through the
  bash script therefore reads as "unknown provenance" on first `update` and needs `--force` once. Use
  the Node CLI if you care about that.
- **A bare `install` records `all: true`** and a later `update` then adopts skills added upstream;
  `install <a> <b>` tracks only those two. `--prune` (opt-in) removes skills deleted upstream.
- **`.DS_Store`, `Thumbs.db`, `desktop.ini` and `.git` are excluded** from both the content hash and
  the copy. Hashing a stray `.DS_Store` made `update` want to "refresh" a skill identical to its source.
- **Automatic updates: the honest framing.** A skill is a passive file. Nothing in this library ever
  executes, so — unlike `claude update`, which works because `claude` is a program that runs and can
  check for itself — there is no moment at which the library could notice it is stale. "Automatic"
  necessarily means installing something that DOES run. `autoupdate --install` installs two such
  things: a **daily scheduled job** (launchd on macOS, a systemd user timer on Linux, schtasks on
  Windows) and a **Claude Code `SessionStart` hook**, so a session never opens on stale skills. Both
  invoke `update --auto`. Neither can push: GitHub cannot reach a laptop, so both poll.
- **`update --auto` is the unattended contract,** and is deliberately more timid than the interactive
  command: it takes a lock in the state dir (a launchd tick and a SessionStart can fire in the same
  second, and two `cpSync`s racing on one destination leave a half-written skill), skips entirely if it
  ran within the hour, **ignores `--force` and `--prune` even when they are passed** (a scheduler that
  could overwrite or delete would eventually do it at 3am to something that mattered), and buffers its
  output so a no-op run prints nothing at all. It speaks only when something changed, was declined, or
  failed.
- **The hook is EXEC form — `command` plus `args`, no shell — and nothing redirects.** A shell string
  was three latent bugs at once: `&&`/`||` are syntax errors in Windows PowerShell 5.1, so SessionStart
  never reached node there; a home or repo path containing a quote or `$(...)` broke the quoting or
  executed a substitution; and a `>>` redirect is opened *before* node starts, so an absent state
  directory killed the hook before it could recreate it. `update --auto` now opens its own log after
  creating the directory, and writes **nothing** to stdout — which is what keeps it out of the session's
  context, `SessionStart` stdout being injected there. For the same open-before-start reason, launchd
  gets no `StandardOutPath` and systemd no `StandardOutput`.
- **systemd values are quoted and `%`-escaped.** `ExecStart` splits on whitespace, so an unquoted
  `AI_SKILLS_HOME="/home/me/AI Skills"` installs a timer that can never run the CLI.
- **The hook's identity is the absolute path of THIS `cli.mjs`.** Matching loose substrings (`cli.mjs`
  plus `update --auto`) also claims another checkout's updater, or any unrelated
  `/opt/tool/cli.mjs update --auto`. Both the exec-form `args` and the legacy shell string are
  recognised, so `--remove` can still clean up hooks written by earlier versions.
- **`settings.json` is written atomically** — temp sibling, `fsync`, rename — because truncating it in
  place means an interrupt or a full disk leaves partial JSON, and partial JSON disables **every**
  setting in the file.
- **`autoupdate` lives in `scripts/autoupdate.mjs`,** not in `cli.mjs`. `cli.mjs` keeps ownership of the
  paths and state and passes them in, so neither file defines them twice. Scheduler installation is
  refused outright from an `npx` cache — that directory is deleted between runs, so a job pointing at
  it would break.
- **For the author of this repo, none of the above is needed to see an edit.** Symlinked skills are live
  the moment a file changes; the scheduler exists only to run the `git pull`. That is also why the curl
  bootstrap clones to a stable `~/.ai-skills` and symlinks from there.
- **Install mode is auto-chosen:** from a clone the CLI **symlinks** (edits/`git pull` go live with no
  re-install); from an ephemeral `npx` cache it **copies** (a symlink into a temp cache would dangle).
  `--copy`/`--link` override. On Windows the CLI uses directory **junctions** (no admin needed).
- **CI is Node, not bash** — `.github/workflows/validate.yml` runs `node scripts/cli.mjs validate` on
  ubuntu. Keep `cli.mjs`'s validator and `validate.sh` in sync if you touch validation logic; the Node
  one is authoritative.
- **`validate.sh` is a 16-line wrapper**, not a second implementation. It execs
  `node scripts/cli.mjs validate`. It used to be an 86-line parallel validator that drifted from the
  Node one — the exact failure the checks exist to catch — and it needed bash ≥ 4 for `declare -A`,
  so it could not run on macOS's stock bash 3.2. One implementation now; both entry points cannot
  disagree, and the wrapper runs anywhere with Node on PATH.
- `dist/` is build output and is **gitignored** — never commit it.
- `.skill` files are plain zips with the skill folder at the root; a `.md` renamed to `.skill` is not
  valid, which is why `package.sh` zips programmatically.

## The six invariants the validator enforces

These are the failure modes that actually break a skill — or silently hollow one out. Treat them as
hard rules when adding or editing a skill:

1. **Folder name must exactly equal the frontmatter `name:`.** A mismatch installs the skill under the
   wrong name. This is the most common break.
2. **Frontmatter must exist** (start with `---`) and contain both `name:` and `description:`.
3. **Every `.sh` a `SKILL.md` invokes must resolve** — it is either bundled somewhere in the repo, or
   the `SKILL.md` generates it itself (a `mv`/`cp`/`tee`/`install`/`>` whose target is that basename).
   A call to a script that is neither is the **exit-127 trap** and fails the build. So when you inline a
   skill's scripts, you must also remove any now-dead `.sh` calls in *other* `SKILL.md` files that
   referenced them.
4. **Every relative markdown link must resolve.** A skill split across `references/` is only as good
   as its links — a dangling one silently drops the procedure it pointed at, and the reader is never
   told. Checked across the `SKILL.md` and every file under its `references/`.
5. **No orphan references.** A file under `references/` that nothing links to is dead weight nobody
   will ever be told to load.
6. **Retired vocabulary stays retired.** A concept deleted from a skill but left referenced elsewhere
   is how `ship-ticket` came to carry fourteen live instructions consuming a classifier that had been
   removed. The retired list lives in `RETIRED_VOCABULARY` in `scripts/cli.mjs`; **add to it whenever
   you delete a concept**, and the check will fail any file that still names it. On its first run it
   found `nn-guard` routing users to a "GATE 2" that never existed in this library.

## Skill anatomy

A `SKILL.md` is YAML frontmatter + a markdown workflow body:

- **`name:`** — must match the folder.
- **`description:`** — a trigger-rich blurb (often listing literal phrases and slash-commands like
  `/sec.audit`, `/cq.init`). This is what Claude Code matches on to decide whether to load the skill, so
  it is dense with "ALWAYS trigger when…" language by design, not prose.
- **body** — the actual instructions/workflow the skill runs.
- **`references/`** (optional) — supporting docs loaded on demand (e.g. `code-quality/references/*.md`
  hold per-stack rule sets: `react.md`, `angular.md`, `nodejs.md`, …).
- **`scripts/`** (optional) — bundled executables the skill invokes.

**Cross-skill references** (load-bearing convention): a skill may point at a sibling skill's
reference file via a relative path like `../code-quality/references/ai-failure-modes.md` — this
resolves in the repo layout AND in `~/.claude/skills` (both symlink and copy installs place
skills side by side). Every such reference MUST carry a one-sentence **fallback summary** in the
same table row/bullet, so a standalone install (sibling skill absent) degrades gracefully instead
of silently dropping the check. Used by: angular/backend-code-quality → code-quality's
ai-failure-modes + test-quality's per-framework files.

**The code-quality family (hub + specialists):** `code-quality` is the **hub** — the universal
front door for any stack. It owns the shared core (`references/universal-principles.md`,
`ai-failure-modes.md`, `review-standard.md`) and the reactive MODE D guard, and it **routes**
Angular work to `angular-code-quality` (`NG-*`) and backend work to `backend-code-quality`
(`BE-*`) for enforced, rule-ID-based review. The specialists are separate skills (so they
auto-trigger and back `ship-ticket`'s rule pass + rule-ID skip protocol), not merged into the hub.
`code-quality`'s per-stack `references/angular.md` and `nodejs.md` are **constitution-level
summaries only** — each carries a header deferring to the specialist as source of truth, so the
two never drift. **But the specialists do not outrank the hub's core.** Their STEP 0
precedence lists apply `universal-principles.md` + `ai-failure-modes.md` **jointly** with
their own `[ARCH]` rules — ranked above would be wrong, since the core forbids
one-implementation interfaces while `NG-SOLID-05`/`BE-SOLID-05` mandate abstractions. Where
the two genuinely collide (the rule says build an abstraction; the core says don't add a
second pattern), a **four-condition test** resolves it: evidence covering the **cited rule's full
applicability** (derived from the rule's own text, with search method and every exclusion
recorded — not a self-chosen "concern") · ratified by a **project-level source predating the
ticket or by the user** (a code comment is never ratification) · the rule protects structure —
**forbidden wherever it enforces or isolates any security, privacy, availability or integrity
control, judged by effect not by a list**, regardless of tier letter · the alternative really
would be a second pattern. All four → the rule does not
fire, recorded as a `NOT_APPLICABLE — replaced by established project architecture` row with its
evidence, outside the waiver ledger. Fewer than four → it stands. The specialists beat the
hub's per-stack *summaries*; they never beat its foundation.

**`ship-ticket` does not run MODE D as a separate second pass:** it preserves
the hub's universal coverage as a whole-diff **`UNIVERSAL` row** (universal-principles + the
project constitution) sitting beside the specialists' unchanged **`AI-FM` row** in one rule-pass
table. Folding the hub's guard into `AI-FM` alone would drop SOLID, DRY, KISS, CQS, the
complexity ceilings and the YAGNI list — so if you touch either row, keep both.
`test-quality` (`TEST-*`) and `docs-accuracy` (`DOC-*`) are adjacent guards the
hub and specialists route to when a diff touches tests or docs.

**The four security skills, and the one line that separates them.** Three of them
**read code**; only `vapt` **runs it**. Keep that boundary — it is the entire
reason `vapt` exists as a separate skill rather than a section of one of the
others:

| Skill | When | Method |
|---|---|---|
| `security` | while writing | secure-by-default patterns, refuse-to-generate list |
| `backend-code-quality` (`BE-SEC-*`/`BE-AUTH-*`/`BE-TEN-*`) | on the diff, in ship-ticket's rule pass | static rule IDs — *the control exists in the file* |
| `security-audit` (`.specs/security-audit/`) | whole codebase, on request | wave-based static reading, spec-tracked findings |
| `vapt` (`VAPT-API-*`/`WEB-*`/`CFG-*`) | after the code is written, in ship-ticket's PROVE phase | attacks a **local** instance — *the control engages* — and commits the abuse cases as tests |

`vapt` is scoped by **trust boundaries, not files** (a pure formatter has no
adversary), its output is **committed tests rather than a report** (so CI, not an
agent's summary, is what blocks the merge), and it runs in two modes: GATE (the
diff) and AUDIT (backfill over already-shipped code in the base branch). Its
`VAPT-*` rules deliberately mirror `BE-SEC-*` one-for-one — the static rule
asserts, the runtime rule proves. **Never point it at production or shared
staging**; that rule of engagement is load-bearing, not boilerplate.

**Spec-artifact root: `.specs/`.** One home for on-disk artifacts across the
library — `ship-ticket` (`.specs/plans/`, `.specs/design-parity/`), `vapt`
(`.specs/vapt/`), `security-audit` (`.specs/security-audit/`), and `spec-driven`
(`.specs/constitution.md`, `.specs/features/<name>/`). `spec-driven` historically
used `.spec/` (singular), so its bundled scripts resolve `SPEC_ROOT` as *"an
existing `.spec/` wins, else `.specs/`"* — that keeps pre-existing projects
working while new ones converge. **Never introduce a third root**, and when
adding a skill that writes artifacts, put them under `.specs/<skill-name>/`.

**`ship-ticket` is a six-phase spine plus on-demand references.** `SKILL.md` owns
the phase table, invariants, state transitions, companion routing and resume
contract. Everything a single
phase consumes lives in `references/<phase>.md` and is loaded when that phase
starts: `understand`, `plan`, `codex-cli`, `prove`, `design-parity`, `review`,
`ship`, with cross-phase operational timing isolated in `observability`. **Keep
it that way.** It was a 2359-line monolith and the length was
itself a defect: policy deleted in one place stayed executable in a dozen others,
and parallelism decided in one section was ignored 350 lines later. If you add a
rule, name the lines it replaces; if it belongs to one phase, it goes in that
phase's reference, not the spine.

The phases are **UNDERSTAND → PLAN → BUILD → PROVE → REVIEW → SHIP**. There are no
numbered steps and no numbered gates any more; the retired `GATE 3/4/5` labels
meant the rule pass, the parity check and the attack testing. The numbering never meant anything
— a GATE 1 and a GATE 2 never existed. **Do not reintroduce numbered steps**: the
cross-references between them were a defect generator.

**Parallelize the dependency graph, not only BUILD.** Every phase derives ready
nodes with explicit inputs, write ownership and exclusive resources. Material
ready nodes run concurrently by default; serialization needs a real dependency,
overlapping writes, shared mutable state or unavailable orchestration. Missing
concurrency is a declared performance degradation, never a user stop. Writing
workers receive disjoint owned paths and never run Git operations, global
formatters/generators or contract changes. The orchestrator owns shared seams,
joins and barriers.

For full-stack work, PLAN drafts one Integration Contract and concurrently checks
it from frontend-consumer and backend-provider perspectives before Codex critiques
the whole plan. Human approval pins that contract. BUILD materializes its source
artifact, then frontend and backend workers depend on the same contract ID—not on
each other's implementation—and run concurrently. The join verifies the digest,
ownership, generated output, provider conformance and consumer conformance before
real integration. Contract drift returns to approval.

**Three rules the bounded workflow exists to protect.** *Coverage and redundancy
are different decisions*: every applicable rule, owned screen, trust boundary and
attack class is checked. Reviewer redundancy is evidence-based: a standard ticket
gets one independent checklist-backed semantic review workflow; a material
full-stack diff may partition frontend, backend and shared-contract coverage
inside that one workflow. Elevated risk adds one concurrent Codex opinion when
available. Security-sensitive work is elevated and
requires explicit attack and security outcomes, but attack applicability still
comes from the changed trust boundaries.

*Review is bounded*: PROVE finishes formatters, generators, tests, docs and
evidence before REVIEW. A clean standard candidate needs one primary workflow.
An elevated candidate may add one concurrent optional opinion. Accepted findings
form at most one consolidated repair batch and only that repair's affected closure
receives one targeted confirmation. A failed confirmation is the result, never a
new review cycle. The exhaustive prose inventory, copied byte preimages,
many-to-many repair packet and unconditional clean-candidate signing dispatch were
deleted because they made workflow bookkeeping cost more than code review.

*Progress never yields*: `CONTINUE` and `AUTO_FIX` execute the next action in the
same turn. Only `WAIT_FOR_USER`, `FAIL` and final `COMPLETE` end the assistant turn.
A phase announcement, finding, tool result, timeout fallback or degradation report
is not a stopping condition. Required capability is preflighted before REVIEW;
optional Codex/concurrency loss degrades instead of serializing or ending the run.

*PLAN means native Plan Mode when the host provides it*: after the predeclared
timing marker, `EnterPlanMode` runs before PLAN research and `ExitPlanMode`
presents the reconciled, Codex-critiqued plan for human approval. A phase heading
or a read-only prompt is not the permission mode. Headless environments retain
the pending-plan approval fallback and never implement before approval.
Plan approval is consumed exactly once: an approved `ExitPlanMode` result, or the
single headless approval response, continues directly into execution. A second
“say go”/confirmation stop is a workflow defect.

*Measure the state machine*: `scripts/run-log.mjs` records workflow, phase,
expensive-activity and legitimate-wait intervals under the target repository's
Git metadata (`ai-skills/ship-ticket/`), never in the worktree. This is operational
state rather than a spec artifact, so it does not introduce another `.specs`
root or alter candidate identity. An open phase with no open wait identifies an
accidental stop; logging failure is declared and never blocks execution.
Because native Plan Mode permits only read-only shell activity, telemetry starts
a `native_plan_mode` interval before entry and closes it immediately after
approved exit; no logger write may be used to bypass that boundary.
Concurrent high-level activities share a `parallel_group` metric; summaries
report wall time, summed work, estimated savings, peak concurrency and
frontend/backend overlap so parallelism is observable rather than aspirational.

PROVE may use two consolidated repair batches. REVIEW may use one repair batch and
one targeted confirmation. Read-only checks and compact append-only execution
events spend neither limit. A Design Contract expansion always returns to human
approval rather than being disguised as a repair.

It is also a **delegator**: it owns the workflow and routes every
language/framework judgment to the code-quality family and to the repo's own
conventions. Its *Stack — detected,
never prescribed* section is the contract; the routing table there sends Angular
frontends to `angular-code-quality`, any other frontend to the `code-quality`
hub, and any backend in any language to `backend-code-quality`. When editing it,
**never reintroduce a named stack as a requirement** — framework names may appear
only as one example among several, or inside the routing table. Concretely: no
hardcoded test runner (read the repo's command), no fixed file globs (derive from
the repo's layout), no assumed i18n/RTL (only if the project ships it), no
assumed migration tool. It has to work on Express+Postgres and Django and Go, not
just the project it was first written for. The same rule binds its newer
machinery: the trust-boundary and view-layer
detectors, the command selection, and any wave partitioning all derive from the
repository — they must never harden into fixed globs or an assumed runner.

**`ship-ticket` has two Codex touchpoints with different dependencies.** The
PLAN critique needs both `codex-delegate` and the `codex` binary. The REVIEW
touchpoint needs only the binary, runs only for an elevated profile, and starts
concurrently with the required primary workflow. A missing plan relay does not
disable the REVIEW route; a missing optional REVIEW engine follows its fallback
and then degrades without blocking the primary workflow.

Check the binary with `codex --version`; do not infer availability from the skill
list. Invoke `codex-delegate` by name because it is installed outside this
library's sibling-skill layout. Codex contributes findings and never approves
the plan or change. The independent primary workflow owns acceptance-criteria,
behavioral, applicable-rule and triggered parity/security outcomes. A full-stack
partition assigns each path and rule once and uses one independent seam
coordinator for the result; it is not multiple full reviews. If a repair occurs,
that workflow confirms only the findings and dependency-closed affected surface;
it never repeats the whole review.

The candidate is bound by `scripts/candidate-id.mjs`, which hashes the final state
of every changed and untracked candidate path relative to the merge base. The plan
artifact and session log are excluded: the approved-plan digest protects the plan
narrative, while compact append-only events record PROVE, REVIEW, repair,
confirmation and SHIP readiness without invalidating reviewed code. SHIP
recomputes the candidate ID before commit and on resume. Commit, push, PR, CI and
tracker outcomes are external facts and never cause a second repository write.

**The ticket pair (`generate-ticket` → tracker → `ship-ticket`):** `generate-ticket`
writes ticket **content only** (per-ticket `.md` + a bulk-import CSV + `INDEX.md`)
and never calls a tracker API; creating the items is a separate explicit step;
`ship-ticket` then implements one, reading it **from the tracker**. That middle hop
is the load-bearing detail — `ship-ticket` never sees `tickets/*.md`, so whatever
the creation step puts in the tracker description is all the implementer gets (MCP
creation carries the full body, CSV import carries only the condensed row).
`generate-ticket` also names two ship-ticket concepts on the ticket it writes —
**the design pin** (read + SHA-pin the design source of truth) and **the parity
check** (diff against that pinned SHA). Both carry a one-sentence fallback gloss in
`generate-ticket/SKILL.md`, per the cross-skill-reference convention above, so the
skill still makes sense installed alone. If you rename a gate in `ship-ticket`,
update those glosses too.

**`pr-review` reviews a PR that already exists — the one review skill that is
*not* about the local diff.** `ship-ticket`'s bounded review and the CodeRabbit
`code-review` skill both judge a diff **before** a PR exists; `pr-review` takes a
PR **URL or ID** (GitHub via `gh`, Azure DevOps via the `repo_pull_request*` MCP
tools), which is usually someone *else's* PR. Three properties are load-bearing:

- **It never touches the user's checkout.** The PR is fetched into a throwaway
  `git worktree` from `refs/pull/<n>/head` (GitHub) or `/merge` (ADO, which often
  publishes no `/head`) — discovered with `git ls-remote`, never assumed — and
  reviewed at `merge-base...HEAD`, so commits merged into the base since the PR
  opened are not blamed on its author. Cleanup runs on every exit path.
- **Three passes, none seeing the others.** A fresh Claude reviewer subagent
  (A), a `codex` process (B), and the stack's code-quality specialist running
  its rule-by-rule **Verification Pass** (C) all read the same diff blind;
  reconciliation is the orchestrator's judgment and attributes each finding
  `[claude]`/`[codex]`/`[rules]`. A and B are free-form and find what they
  notice; C exists because the worst defects are **absences** — its table has a
  row per rule in force, so an unperformed check surfaces as an empty box
  instead of as silence. C shares A's model, so it adds method diversity, not
  model diversity — never report it as a third opinion. Since there is no
  Design Contract here, C derives the rules in force from the diff (every
  `[NN]` rule + every rule whose surface the diff touches + a mandatory `AI-FM`
  row), and a FAIL is a finding rather than a gate. Dropping a finding requires
  a contract failure or a **named rule ID** — a bare "style-only" retires
  nothing.
- **Report-first, post-on-approval.** Findings land in `.specs/pr-review/<host>-<id>.md`;
  comments reach the PR only after the user approves them, and the skill never
  approves, votes, or requests changes — that is a human act.

**Do not rename it `code-review`** — that name is taken by the installed
CodeRabbit plugin skill, and a collision shadows one of them.

**Its `codex review` invocation is version-pinned knowledge, verified on
`codex-cli 0.145.0`:** the scope flags (`--uncommitted`, `--base`, `--commit`)
**each conflict with a custom `[PROMPT]`**, including the `-` stdin form — the
command exits during argument parsing. So a Codex pass is either *instructed*
(bare prompt, scope stated in the prompt text) or *scoped* (`--base`, no
instructions, and its findings arrive as `[P1]`/`[P2]` prose with no quoted
line). Both routes print their final report **twice** and emit **absolute
worktree paths**, so dedupe and strip the prefix before anything is posted.
**`ship-ticket`'s elevated Codex opinion carries the same constraint** — it used to
document `codex review --uncommitted "<instructions>"`, which exits during
argument parsing on 0.145.0, and now states the scope in the prompt instead.
**That optional opinion always sets `-c model_reasoning_effort=` explicitly rather than
inheriting the account's global default** — measured on this repo, same diff and
prompt, `xhigh` took 384s against `medium`'s 177s (2.2x) — and asks for
severity-ordered findings rather than unbounded enumeration.

**What the two skills must keep in sync, and what they need not.** The *CLI
contract* is shared and must match in both: the scope-flag-vs-prompt conflict, the
duplicated final report, and the absolute paths. The *cost policy* — an explicit,
constant `model_reasoning_effort` and the bounded ask — is
`ship-ticket`'s; `pr-review` reviews one PR and may keep a bare invocation.
**Effort is pinned whenever the optional opinion runs**: profile selection decides
whether redundancy is needed; it does not weaken a dispatched review. If you
change how either skill invokes Codex, change both. An effort-policy-only change
may remain local to ship-ticket.

## Script-delivery patterns

Most skills are pure `SKILL.md`. Three use scripts in different ways — mirror the
matching pattern when extending them:

- **`spec-driven`** — *bundles* `scripts/*.sh` in the repo (`specify.sh`, `plan.sh`, `tasks.sh`, …) and
  its `setup.sh` copies them into a target project's `.claude/skills/spec-driven/scripts/` at first use.
  Scripts create files; the skill only decides the content.
- **`nn-guard`** — *generates* its script into the target project at install time, writing
  `.claude/hooks/nn-guard.sh` (a `mv`/`chmod` in the `SKILL.md`), then wiring it as a PostToolUse hook
  and a CI check. Nothing is bundled; the invariant-3 check passes because the `SKILL.md` creates the
  file it references.
- **`ship-ticket`** — *executes bundled cross-platform Node helpers in place*.
  `scripts/candidate-id.mjs` computes stable reviewed-candidate identity;
  `scripts/run-log.mjs` appends local timing telemetry under Git metadata. Neither
  needs project-local setup, so symlink and copy installs behave the same.

## Adding or editing a skill

1. Create `skills/<name>/SKILL.md` (or edit an existing one) — with the symlink install, edits are
   already live in Claude Code, no re-install needed.
2. Keep folder name == `name:`, include `name:` + `description:`, and make sure any `.sh` you invoke is
   bundled or self-generated.
3. `node scripts/cli.mjs validate` → should print `✅ <name>` for it and `✅ all skills valid`.
4. `git add -A && git commit` — CI re-runs the validator, so a skill that breaks the invariants can't
   reach `main`.

**Editing safely, because edits here are live the moment they are written.** A
half-finished `SKILL.md` in this repo is a half-finished skill in the agent that
loads it, and a large edit spans several files that only make sense together.
Six rules, each of which exists because it was broken:

- **Never whole-file-revert to undo one edit.** `git checkout -- <file>`,
  `git restore`, `git stash` and an overwriting `Write` all discard everything
  uncommitted in that file, not just the change you meant to reverse. Check
  `git diff --stat <file>` first and delete the specific text instead. Planting a
  deliberate violation to prove a check fires is good practice — remove it the way
  you added it.
- **Write each edit as you make it, not at the end of a batch.** A script that
  accumulates several replacements and writes once will silently discard all of
  them if a later assertion fails. Assert per replacement, and write per file.
- **Never put a line break inside a match anchor you typed from memory.** Exact-match
  replacement fails on the two things reconstruction always gets wrong: line wrapping
  and leading indentation — a wrapped list item, or a YAML block scalar whose
  continuation lines each carry two spaces. Anchor on one short distinctive phrase
  from a single line, or read the line range and use the bytes it returns.
- **Verify a claim against the file before making it.** After a multi-edit script,
  `grep` for a distinctive phrase from each edit. Before saying a check or rule
  exists, confirm it is in a tracked path rather than a scratch script. A commit
  message and its diff must agree — describing what you intended to add rather than
  what the diff contains is how an unverified claim reaches `main`.

- **Read one git blob per Bash call — never in a shell loop.** Verified here: the
  same historical file measured three ways gave 674 lines directly, 841 via
  `git show` inside a `for` loop, and 88 via `git cat-file -p` inside one, including
  when written to a temp file first. Comparing N versions means N invocations, or a
  Python runtime — not a loop. A per-commit table built in a shell loop is fiction.
- **An impossible number means the tool is broken, not the subject.** Before using a
  measurement, ask what it should roughly be; a large discrepancy against something
  you just read, or values in one run that disagree wildly with each other, means
  re-derive it another way rather than falling back on what you already believed.

**Draft a large rewrite outside the repo and swap it in once**, for the same
reason: the intermediate states of a multi-file rewrite are live skills that nobody
wrote on purpose.
