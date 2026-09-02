# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Single source of truth for a personal Claude Code **skill library**. Each skill is a folder
`skills/<name>/` containing a `SKILL.md` (plus optional `references/` and `scripts/`). The repo is
**symlinked into `~/.claude/skills`** (via `install.sh`), so editing a `SKILL.md` here makes it live
in Claude Code immediately — the "update" and "backup" loops are the same `git commit`. There is no
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
node scripts/cli.mjs install --target codex|gemini|agents|all   # other AI tools (SKILL.md is an
                                          # open standard; codex/agents → ~/.agents/skills,
                                          # gemini → ~/.gemini/skills); --dest <path> for custom dirs

# Bash alternatives (macOS/Linux/Git Bash/WSL):
./scripts/install.sh [--copy] [--target <t,..>|--dest <path>] [names...]  # full mirror of cli install
./scripts/validate.sh                     # bash mirror of the validator — needs bash ≥ 4 (see note)
./scripts/package.sh [<name>]             # build dist/<name>.skill zips (needs python3)
./scripts/import.sh [--force]             # fold an externally-installed skill back into the repo
```

- **Install mode is auto-chosen:** from a clone the CLI **symlinks** (edits/`git pull` go live with no
  re-install); from an ephemeral `npx` cache it **copies** (a symlink into a temp cache would dangle).
  `--copy`/`--link` override. On Windows the CLI uses directory **junctions** (no admin needed).
- **CI is Node, not bash** — `.github/workflows/validate.yml` runs `node scripts/cli.mjs validate` on
  ubuntu. Keep `cli.mjs`'s validator and `validate.sh` in sync if you touch validation logic; the Node
  one is authoritative.
- **`validate.sh` requires bash ≥ 4** (it uses `declare -A`). macOS ships bash 3.2 as `/bin/bash` and
  fails with `declare: -A: invalid option` — prefer `node scripts/cli.mjs validate` there.
- `dist/` is build output and is **gitignored** — never commit it.
- `.skill` files are plain zips with the skill folder at the root; a `.md` renamed to `.skill` is not
  valid, which is why `package.sh` zips programmatically.

## The three invariants the validator enforces

These are the failure modes that actually break a skill install — treat them as hard rules when adding
or editing a skill:

1. **Folder name must exactly equal the frontmatter `name:`.** A mismatch installs the skill under the
   wrong name. This is the most common break.
2. **Frontmatter must exist** (start with `---`) and contain both `name:` and `description:`.
3. **Every `.sh` a `SKILL.md` invokes must resolve** — it is either bundled somewhere in the repo, or
   the `SKILL.md` generates it itself (a `mv`/`cp`/`tee`/`install`/`>` whose target is that basename).
   A call to a script that is neither is the **exit-127 trap** and fails the build. So when you inline a
   skill's scripts, you must also remove any now-dead `.sh` calls in *other* `SKILL.md` files that
   referenced them.

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
auto-trigger and back `ship-ticket`'s GATE 3 + rule-ID skip protocol), not merged into the hub.
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
fire, recorded as an `N/A — replaced by established project architecture` row with its
evidence, outside the waiver ledger. Fewer than four → it stands. The specialists beat the
hub's per-stack *summaries*; they never beat its foundation.

**`ship-ticket` no longer runs MODE D as a separate second pass:** it preserves
the hub's universal coverage as a whole-diff **`UNIVERSAL` row** (universal-principles + the
project constitution) sitting beside the specialists' unchanged **`AI-FM` row** in one GATE 3
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
| `backend-code-quality` (`BE-SEC-*`/`BE-AUTH-*`/`BE-TEN-*`) | on the diff, ship-ticket GATE 3 | static rule IDs — *the control exists in the file* |
| `security-audit` (`.specs/security-audit/`) | whole codebase, on request | wave-based static reading, spec-tracked findings |
| `vapt` (`VAPT-API-*`/`WEB-*`/`CFG-*`) | after the code is written, ship-ticket GATE 5 | attacks a **local** instance — *the control engages* — and commits the abuse cases as tests |

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

**`ship-ticket` is stack-agnostic by design — keep it that way.** It is a
**delegator**: it owns the workflow (read ticket → pin design → plan → gate →
review → close out) and routes every language/framework judgment to the
code-quality family and to the repo's own conventions. Its *Stack — detected,
never prescribed* section is the contract; the routing table there sends Angular
frontends to `angular-code-quality`, any other frontend to the `code-quality`
hub, and any backend in any language to `backend-code-quality`. When editing it,
**never reintroduce a named stack as a requirement** — framework names may appear
only as one example among several, or inside the routing table. Concretely: no
hardcoded test runner (read the repo's command), no fixed file globs (derive from
the repo's layout), no assumed i18n/RTL (only if the project ships it), no
assumed migration tool. It has to work on Express+Postgres and Django and Go, not
just the project it was first written for. The same rule binds its newer
machinery: the **run-lane classifier**, the trust-boundary and view-layer
detectors, the command selection, and any wave partitioning all derive from the
repository — they must never harden into fixed globs or an assumed runner.

**`ship-ticket`'s cross-model review depends on things this repo does not ship —
and its two Codex touchpoints do not depend on the same ones.**
Those touchpoints are the **step 6.3 plan review** (the drafted plan goes to
Codex read-only *before* the user approves it, and is a **recorded lane decision rather
than a degradation** when the run is in the FAST lane) and **pass B in step 13c**
(`codex review` on the local diff, run **concurrently** with the fresh-Claude pass A and
the rule pass C over one frozen manifest, with `/coderabbit:code-review` as the declared
fallback). The **plan review needs both** the external
[`codex-delegate`](https://github.com/amElnagdy/delegate-skills) skill *and* the
`codex` CLI on PATH, because it dispatches through the relay; **pass B needs only
the `codex` binary.** A missing `codex-delegate` therefore costs the plan critique
and leaves the diff review intact — never disable both because one is absent. Two rules keep that dependency honest: **check the
binary, not the skill list** (a CLI companion is available only if `codex --version`
succeeds — the availability table's skill test cannot see it), and **never reference
`codex-delegate` by relative path** — it installs to `~/.agents/skills`, not beside
this repo's skills, so the `../<sibling>/` convention used inside the code-quality
family does not resolve for it; invoke it **by name** and let it supply its own relay
path. Codex is always a *contributor*: it critiques the plan and the diff, it never
approves either, and its absence degrades the review loudly rather than stopping the
run. It is also an accepted signer for GATE 4's independent parity signature (a
separate process with no build context), recorded as `codex <version>, session
<threadId>` from the relay's `result.json`.

**`ship-ticket` borrows `pr-review`'s blind concurrent A/B/C structure** for its diff
review, while keeping its own gate semantics and its local-uncommitted scope. Two
things make that safe and they are load-bearing: the passes are **report-only** (a
reviewer that fixes code invalidates its peers' conclusions) and every pass is bound to
a **frozen manifest** — `merge-base…HEAD committed delta + index/worktree status +
untracked files, with per-path digests, modes, rename origins, deletion tombstones
and symlink targets` (the committed layer matters: a resumed branch may carry WIP
commits that `git status` cannot see) — computed
**once** and handed to all of them, because a bare `git diff` hides staged changes and a
pass that reviewed a narrower set has gated nothing. The manifest is an integrity check
over the live tree, **not a commit**: step 19 is the only commit the workflow
*creates*, followed by the step-20 tracker transition — pre-existing WIP commits on
a resumed branch may survive it, but only by an explicit human decision.
Concurrency itself is a **third kind of companion** — an orchestration capability, not a
skill or a binary — and its absence degrades the wave to serial execution over the same
manifest, declared like any other degradation. It never removes a pass.

**The ticket pair (`generate-ticket` → tracker → `ship-ticket`):** `generate-ticket`
writes ticket **content only** (per-ticket `.md` + a bulk-import CSV + `INDEX.md`)
and never calls a tracker API; creating the items is a separate explicit step;
`ship-ticket` then implements one, reading it **from the tracker**. That middle hop
is the load-bearing detail — `ship-ticket` never sees `tickets/*.md`, so whatever
the creation step puts in the tracker description is all the implementer gets (MCP
creation carries the full body, CSV import carries only the condensed row).
`generate-ticket` also names two ship-ticket concepts on the ticket it writes —
**Step 0.5** (read + SHA-pin the design source of truth) and **GATE 4** (parity
diff against that pinned SHA). Both carry a one-sentence fallback gloss in
`generate-ticket/SKILL.md`, per the cross-skill-reference convention above, so the
skill still makes sense installed alone. If you rename a gate in `ship-ticket`,
update those glosses too.

**`pr-review` reviews a PR that already exists — the one review skill that is
*not* about the local diff.** `ship-ticket`'s passes and the CodeRabbit
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
**`ship-ticket`'s pass B (step 13c) carries the same constraint** — it used to
document `codex review --uncommitted "<instructions>"`, which exits during
argument parsing on 0.145.0, and now states the scope in the prompt instead.
**Pass B also always sets `-c model_reasoning_effort=` explicitly rather than
inheriting the account's global default** — measured on this repo, same diff and
prompt, `xhigh` took 384s against `medium`'s 177s (2.2x) — and asks for
severity-ordered findings rather than unbounded enumeration.

**What the two skills must keep in sync, and what they need not.** The *CLI
contract* is shared and must match in both: the scope-flag-vs-prompt conflict, the
duplicated final report, and the absolute paths. The *cost policy* — explicit
per-lane `model_reasoning_effort` and the bounded ask — is `ship-ticket`'s, because
it has run lanes to key it to; `pr-review` reviews one PR with no lane and may keep
a bare invocation. If you change how either skill talks to the CLI, change both; if
you change only the effort policy, you need not. If you
change how either skill invokes Codex, change both.

## Two script-delivery patterns

Most skills are pure `SKILL.md`. Two ship scripts, in different ways — mirror the matching pattern when
extending them:

- **`spec-driven`** — *bundles* `scripts/*.sh` in the repo (`specify.sh`, `plan.sh`, `tasks.sh`, …) and
  its `setup.sh` copies them into a target project's `.claude/skills/spec-driven/scripts/` at first use.
  Scripts create files; the skill only decides the content.
- **`nn-guard`** — *generates* its script into the target project at install time, writing
  `.claude/hooks/nn-guard.sh` (a `mv`/`chmod` in the `SKILL.md`), then wiring it as a PostToolUse hook
  and a CI check. Nothing is bundled; the invariant-3 check passes because the `SKILL.md` creates the
  file it references.

## Adding or editing a skill

1. Create `skills/<name>/SKILL.md` (or edit an existing one) — with the symlink install, edits are
   already live in Claude Code, no re-install needed.
2. Keep folder name == `name:`, include `name:` + `description:`, and make sure any `.sh` you invoke is
   bundled or self-generated.
3. `node scripts/cli.mjs validate` → should print `✅ <name>` for it and `✅ all skills valid`.
4. `git add -A && git commit` — CI re-runs the validator, so a skill that breaks the invariants can't
   reach `main`.
