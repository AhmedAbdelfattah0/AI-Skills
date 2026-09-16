# AI-Skills

A shareable library of AI agent skills in the open
[`SKILL.md` standard](https://agentskills.io) — built for
[Claude Code](https://claude.com/claude-code), and equally installable into **OpenAI Codex,
Gemini CLI, Google Antigravity, and any other standard-compliant tool** (see
[Use with other AI tools](#use-with-other-ai-tools-codex-gemini-cli-antigravity-glm-)). Each skill lives in
`skills/<name>/` with a `SKILL.md` (plus optional `references/` or `scripts/`).

There's a **cross-platform installer** (`ai-skills`, a dependency-free Node CLI) that runs on
**Windows, macOS, and Linux**, so you can install everything or just the skills you want — no clone
required. A bash equivalent is kept for people who prefer a shell script on Unix.

## Install

### Option A — one line, with automatic updates

```bash
curl -fsSL https://raw.githubusercontent.com/AhmedAbdelfattah0/AI-Skills/main/install.sh | bash
```

Clones into `~/.ai-skills`, symlinks every skill into `~/.claude/skills`, and turns on automatic
updates. Needs `git` and Node 18+. Overrides: `AI_SKILLS_TARGET=all` for every tool,
`AI_SKILLS_HOME=<dir>` to keep the clone elsewhere, `AI_SKILLS_NO_AUTOUPDATE=1` to skip scheduling.

### Option B — `npx` (no clone needed, works everywhere)

Requires [Node.js](https://nodejs.org) ≥ 18 (ships with `npx`). This runs the installer straight from
GitHub:

```bash
# see what's available
npx github:AhmedAbdelfattah0/AI-Skills list

# install ALL skills
npx github:AhmedAbdelfattah0/AI-Skills install

# install ONE skill, or SEVERAL (space-separated)
npx github:AhmedAbdelfattah0/AI-Skills install security
npx github:AhmedAbdelfattah0/AI-Skills install security researcher spec-driven

# the ticket workflow — write the backlog, then implement it ticket by ticket
npx github:AhmedAbdelfattah0/AI-Skills install generate-ticket ship-ticket

# install for OTHER AI tools (default is Claude Code) — see "Use with other AI tools"
npx github:AhmedAbdelfattah0/AI-Skills install --target codex        # OpenAI Codex
npx github:AhmedAbdelfattah0/AI-Skills install --target gemini       # Gemini CLI
npx github:AhmedAbdelfattah0/AI-Skills install --target antigravity  # Google Antigravity
npx github:AhmedAbdelfattah0/AI-Skills install --target all          # all four at once
```

When run this way the source is a throwaway `npx` cache, so skills are **copied** into
`~/.claude/skills/`. To pick them up later, run `update` — npm re-resolves the GitHub spec on every
`npx` run, so it always fetches the current `main`:

```bash
npx github:AhmedAbdelfattah0/AI-Skills update
```

On Windows, run the same lines in PowerShell or Command Prompt — `npx` is cross-platform.

### Option C — clone, then install (best if you'll edit or update skills)

```bash
git clone https://github.com/AhmedAbdelfattah0/AI-Skills.git
cd AI-Skills

node scripts/cli.mjs list                        # list skills
node scripts/cli.mjs install                     # install ALL (symlinked)
node scripts/cli.mjs install security researcher # install only these
node scripts/cli.mjs install generate-ticket ship-ticket   # the ticket workflow pair
node scripts/cli.mjs install --copy              # install ALL as real files (no symlink)
node scripts/cli.mjs install --target all        # also into Codex + Gemini CLI + Antigravity dirs
```

From a clone, skills are **symlinked** by default, so `git pull` (or editing a `SKILL.md`) updates what
Claude Code sees with no re-install. Use `--copy` if you'd rather have real files. On **Windows** the
CLI creates directory *junctions* (no admin rights needed); if a symlink is ever refused, add `--copy`.

### Option D — bash installer (macOS / Linux / Git Bash / WSL)

Same behaviour as Option C, no Node required:

```bash
./scripts/install.sh                     # all skills, symlinked (Claude Code)
./scripts/install.sh security researcher # only these
./scripts/install.sh generate-ticket ship-ticket   # the ticket workflow pair
./scripts/install.sh --copy              # all skills, real files
./scripts/install.sh --target codex      # → ~/.agents/skills (OpenAI Codex)
./scripts/install.sh --target all        # Claude + Codex + Gemini + Antigravity at once
./scripts/install.sh --dest <path>       # any other tool's skills dir
```

### Verify

After installing, run `/skills` (or restart) in Claude Code and confirm the skills appear.

## Staying up to date

`update` is to your skills what `claude update` is to Claude Code: one command that fetches and
re-syncs.

```bash
node scripts/cli.mjs update           # pull the source, then re-sync every skill it installed
node scripts/cli.mjs update --check   # say what would change; write nothing
node scripts/cli.mjs update --prune   # also remove skills that no longer exist upstream
node scripts/cli.mjs update security  # just this one
```

It updates **every** skills directory it finds — Claude Code, Codex, Gemini, Antigravity — not only
the default one, and handles each install shape on its own terms:

| what you installed | what `update` does |
| --- | --- |
| a symlink into your clone | nothing to copy — the `git pull` *was* the update |
| a symlink somewhere else | reports it, never touches it |
| a copy that matches what was installed | refreshes it from the new source |
| a copy you edited yourself | **leaves it alone** and tells you, until you pass `--force` |
| a directory nobody recorded installing | **leaves it alone** — it may be someone else's; `--adopt` takes it over |

Those last two rows are why `install` writes a small `.ai-skills-manifest.json` beside your skills: a
stale skill and a skill you customised look identical on disk, and only a recorded baseline tells them
apart. It also records which library installed them (the git remote), so a second clone or a fork can't
read the first one's records and quietly overwrite its content. Your edits are never overwritten
silently, and `update` never claims a directory it has no record of installing.

Nothing is ever deleted before its replacement exists: a new copy is staged alongside, swapped in by
rename, and only then is the old one dropped — so a full disk or an interrupted run leaves the working
skill exactly where it was.

The source refresh is a `git pull --ff-only`, and only from a clean tree with an upstream. If your
checkout is dirty, has no upstream, or has diverged, `update` says so and re-syncs from the checkout as
it stands — it will not stash, rebase, or discard anything.

### Never running it yourself

```bash
node scripts/cli.mjs autoupdate --install   # turn it on
node scripts/cli.mjs autoupdate             # what's on, and when it last ran
node scripts/cli.mjs autoupdate --remove    # turn it all off
```

Worth being straight about why this takes machinery at all: `claude update` works because `claude` is
a **program that runs** and can check for itself on startup. Skills are just files. Nothing here ever
executes, so nothing can notice it's out of date — and GitHub can't push to your laptop. Automatic
updates therefore install two things that *do* run, both of which poll:

| | what it is | when it fires |
| --- | --- | --- |
| **Daily job** | launchd (macOS), systemd user timer (Linux), schtasks (Windows) | once a day, whether or not you're working |
| **SessionStart hook** | `~/.claude/settings.json` | when a Claude Code session starts, so it never opens on stale skills |

Both call `update --auto`, which is deliberately more cautious than the command you'd type: it takes a
lock, runs at most once an hour, and **ignores `--force`, `--adopt` and `--prune` even if passed** — a
scheduler that could overwrite, claim or delete would eventually do it at 3am to something you cared
about. It writes only to its own log and never to stdout, so it neither delays startup nor talks into
your session.

**If your skills are symlinked into a clone, none of this is needed to see an edit** — saving a
`SKILL.md` is live instantly, and the scheduler exists only to run the `git pull` for you.

> **Optional:** run `npm link` in the clone to get an `ai-skills` command on your PATH, then use
> `ai-skills install …` anywhere instead of `node scripts/cli.mjs …`.

## Use with other AI tools (Codex, Gemini CLI, Antigravity, GLM, …)

`SKILL.md` is no longer Claude-only — it's an **open standard**
([agentskills.io](https://agentskills.io), governed by the Linux Foundation's Agentic AI
Foundation since Dec 2025) supported by 16+ tools including **OpenAI Codex**, **Gemini CLI**,
**Google Antigravity**, GitHub Copilot, Cursor, OpenCode, and Amp. The same skill folders work as-is; only the
directory each tool scans differs. Use `--target`:

```bash
node scripts/cli.mjs install --target codex               # OpenAI Codex   → ~/.agents/skills
node scripts/cli.mjs install --target gemini              # Gemini CLI     → ~/.gemini/skills
node scripts/cli.mjs install --target antigravity         # Antigravity    → ~/.gemini/antigravity/skills
node scripts/cli.mjs install --target all                 # Claude + Codex + Gemini + Antigravity at once
node scripts/cli.mjs install security --target claude,codex   # one skill, two tools
node scripts/cli.mjs install --dest /path/to/dir          # any other tool's skills dir
```

The same `--target` / `--dest` flags work in all three install paths:
`npx github:AhmedAbdelfattah0/AI-Skills install --target codex` (no clone needed) and
`./scripts/install.sh --target codex` (bash) behave identically.

Per-tool notes:

- **OpenAI Codex** — reads `~/.agents/skills` (and `.agents/skills` in a repo). Skills trigger
  implicitly when your task matches the `description`, or explicitly via `/skills` / `$`-mention.
  Codex's old "custom prompts" are deprecated in favor of skills.
- **Gemini CLI** — reads `~/.gemini/skills` and also the interoperable `~/.agents/skills`, so
  `--target codex` (or `agents`) covers Gemini too. Manage with `/skills enable <name>`.
- **Google Antigravity** — global skills live in `~/.gemini/antigravity/skills` (a *different*
  directory from Gemini CLI's `~/.gemini/skills`, so `--target gemini` does **not** cover it);
  per-project skills go in `<repo>/.agents/skills` (the older `.agent/skills` still works).
  `description` is the only required frontmatter field, so every skill here qualifies. If
  Antigravity doesn't pick up symlinked skills on your machine, re-run with `--copy`.
- **GLM (Zhipu)** — GLM Coding Plan runs *through* Claude Code or Claude-compatible tools
  (OpenCode, Cline, …), so a normal `install` already covers it. Nothing extra needed.
- **Repo-level sharing** — to ship skills with a project instead of a user's machine, use
  `--dest <repo>/.agents/skills` and commit; Codex, Gemini CLI, and Antigravity all scan that
  path.

**Portability caveat:** every skill loads in every standard-compliant tool, but a few contain
instructions that only make sense in Claude Code — `nn-guard` installs a Claude Code hook (its
CI half is portable), and `ship-ticket` / `session-logger` reference Claude Code commands like
`/compact` and subagents. The knowledge in them still applies; those specific steps are
Claude-only.

## Skills (20)

| Skill | Extras |
|---|---|
| angular-code-quality | `references/` |
| docs-accuracy | `references/` (claim verification, code samples, docstrings) |
| backend-code-quality | `references/` |
| code-quality | `references/` (per-stack rule sets) |
| cost-reducer | — |
| design-prompts | — |
| generate-ticket | `references/` (ticket template, CSV schemas, worked example) |
| linkedin-content-coach | — |
| nn-guard | `references/` (generates `.claude/hooks/nn-guard.sh` at install) |
| pr-review | — (three-pass review of an open GitHub/ADO PR; `.specs/pr-review/`) |
| researcher | — |
| security | — |
| security-audit | — |
| self-healing | — |
| session-logger | — |
| session-restore | — |
| ship-ticket | `references/` + `scripts/` (contract-first parallel delivery, Claude↔Codex planning debate and review, stable candidate identity, and timing telemetry) |
| spec-driven | `scripts/` (bundled; copied into a project via `setup.sh`) |
| test-quality | `references/` (per-framework: jest-vitest, pytest, phpunit, llm-app-testing) |
| vapt | — (runtime abuse tests committed to the repo; `.specs/vapt/`) |

Run `ai-skills list` (or `node scripts/cli.mjs list`) for the one-line description of each.

## Layout

```
AI-Skills/
├── skills/<name>/SKILL.md         # + optional references/ and scripts/
├── scripts/
│   ├── cli.mjs                    # the CLI: list / install / update / autoupdate / validate
│   ├── autoupdate.mjs             # scheduled job + SessionStart hook, install and removal
│   ├── install.sh                 # bash installer (Unix) — all or named skills, --copy
│   ├── import.sh                  # optional: pull other installed skills into the repo
│   ├── validate.sh                # thin wrapper — execs the Node validator, not a second copy
│   └── package.sh                 # build dist/<name>.skill zips for backup/sharing
├── install.sh                     # curl|bash bootstrap: clone → install → autoupdate
├── package.json                   # exposes the `ai-skills` bin for npx / npm link
├── .github/workflows/validate.yml # CI runs `node scripts/cli.mjs validate` on push/PR
└── README.md
```

## Contributing a skill

1. Add `skills/<name>/SKILL.md` (optionally a `references/` and/or `scripts/` folder).
2. Keep the folder name **exactly equal** to the frontmatter `name:`, and include both `name:` and
   `description:`.
3. Validate before pushing — cross-platform:

   ```bash
   node scripts/cli.mjs validate      # any OS with Node
   ./scripts/validate.sh              # or bash (needs bash ≥ 4; macOS ships 3.2)
   ```

CI runs the same Node validator on every push/PR, so a skill that breaks the rules can't reach `main`.

## What the validator enforces

- **Folder name = frontmatter `name:`** — must match exactly, or the skill installs under the wrong name.
- **Frontmatter present** with both `name:` and `description:`.
- **Every `.sh` a `SKILL.md` invokes must exist** — either bundled in the repo (like
  `spec-driven/scripts/*.sh`) or generated by the skill itself (like nn-guard writing its hook). A call
  to a script that is neither is the classic exit-127 trap and fails the build.

## Backup / sharing archives (optional)

```bash
./scripts/package.sh                 # build dist/<name>.skill zips (needs python3; dist/ is gitignored)
./scripts/package.sh session-logger  # just one
```

`.skill` files are plain zips with the skill folder at the root — a `.md` renamed to `.skill` is **not**
valid, which is why `package.sh` zips programmatically.

## Notes on the copies in this repo

- Parts of `test-quality`, `docs-accuracy`, and `code-quality`'s
  `ai-failure-modes.md` / `universal-principles.md` are adapted from
  [amElnagdy/guard-skills](https://github.com/amElnagdy/guard-skills) (MIT),
  with primary-source citations in each skill's `sources.md`.
- `session-logger` / `session-restore` are the current inlined versions (no external scripts).
- `spec-driven` had two dead calls to `session-restore/scripts/restore.sh` and
  `session-logger/scripts/append.sh` (both removed when those skills were inlined). They're replaced
  here with the inline equivalents so the workflow can't exit-127. Its own bundled scripts are untouched.
