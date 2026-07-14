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

# Bash alternatives (macOS/Linux/Git Bash/WSL):
./scripts/install.sh [--copy] [names...]  # mirror of cli install (selective + copy supported)
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
