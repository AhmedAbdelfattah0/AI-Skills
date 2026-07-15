# AI-Skills

A shareable library of AI agent skills in the open
[`SKILL.md` standard](https://agentskills.io) — built for
[Claude Code](https://claude.com/claude-code), and equally installable into **OpenAI Codex,
Gemini CLI, and any other standard-compliant tool** (see
[Use with other AI tools](#use-with-other-ai-tools-codex-gemini-cli-glm-)). Each skill lives in
`skills/<name>/` with a `SKILL.md` (plus optional `references/` or `scripts/`).

There's a **cross-platform installer** (`ai-skills`, a dependency-free Node CLI) that runs on
**Windows, macOS, and Linux**, so you can install everything or just the skills you want — no clone
required. A bash equivalent is kept for people who prefer a shell script on Unix.

## Install

### Option A — `npx` (no clone needed, works everywhere)

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

# install for OTHER AI tools (default is Claude Code) — see "Use with other AI tools"
npx github:AhmedAbdelfattah0/AI-Skills install --target codex     # OpenAI Codex
npx github:AhmedAbdelfattah0/AI-Skills install --target gemini    # Gemini CLI
npx github:AhmedAbdelfattah0/AI-Skills install --target all       # Claude + Codex + Gemini
```

When run this way the source is a throwaway `npx` cache, so skills are **copied** into
`~/.claude/skills/`. To pick up new skills later, re-run the command. On Windows, run the same lines in
PowerShell or Command Prompt — `npx` is cross-platform.

### Option B — clone, then install (best if you'll edit or update skills)

```bash
git clone https://github.com/AhmedAbdelfattah0/AI-Skills.git
cd AI-Skills

node scripts/cli.mjs list                       # list skills
node scripts/cli.mjs install                     # install ALL (symlinked)
node scripts/cli.mjs install security researcher # install only these
node scripts/cli.mjs install --copy              # install ALL as real files (no symlink)
node scripts/cli.mjs install --target all        # also into Codex + Gemini CLI dirs
```

From a clone, skills are **symlinked** by default, so `git pull` (or editing a `SKILL.md`) updates what
Claude Code sees with no re-install. Use `--copy` if you'd rather have real files. On **Windows** the
CLI creates directory *junctions* (no admin rights needed); if a symlink is ever refused, add `--copy`.

> **Optional:** run `npm link` in the clone to get an `ai-skills` command on your PATH, then use
> `ai-skills install …` anywhere instead of `node scripts/cli.mjs …`.

### Option C — bash installer (macOS / Linux / Git Bash / WSL)

Same behaviour as Option B, no Node required:

```bash
./scripts/install.sh                     # all skills, symlinked (Claude Code)
./scripts/install.sh security researcher # only these
./scripts/install.sh --copy              # all skills, real files
./scripts/install.sh --target codex      # → ~/.agents/skills (OpenAI Codex)
./scripts/install.sh --target all        # Claude + Codex + Gemini at once
./scripts/install.sh --dest <path>       # any other tool's skills dir
```

### Verify

After installing, run `/skills` (or restart) in Claude Code and confirm the skills appear.

## Use with other AI tools (Codex, Gemini CLI, GLM, …)

`SKILL.md` is no longer Claude-only — it's an **open standard**
([agentskills.io](https://agentskills.io), governed by the Linux Foundation's Agentic AI
Foundation since Dec 2025) supported by 16+ tools including **OpenAI Codex**, **Gemini CLI**,
GitHub Copilot, Cursor, OpenCode, and Amp. The same skill folders work as-is; only the
directory each tool scans differs. Use `--target`:

```bash
node scripts/cli.mjs install --target codex               # OpenAI Codex   → ~/.agents/skills
node scripts/cli.mjs install --target gemini              # Gemini CLI     → ~/.gemini/skills
node scripts/cli.mjs install --target all                 # Claude + Codex + Gemini at once
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
- **GLM (Zhipu)** — GLM Coding Plan runs *through* Claude Code or Claude-compatible tools
  (OpenCode, Cline, …), so a normal `install` already covers it. Nothing extra needed.
- **Repo-level sharing** — to ship skills with a project instead of a user's machine, use
  `--dest <repo>/.agents/skills` and commit; Codex and Gemini CLI both scan that path.

**Portability caveat:** every skill loads in every standard-compliant tool, but a few contain
instructions that only make sense in Claude Code — `nn-guard` installs a Claude Code hook (its
CI half is portable), and `ship-ticket` / `session-logger` reference Claude Code commands like
`/compact` and subagents. The knowledge in them still applies; those specific steps are
Claude-only.

## Skills (15)

| Skill | Extras |
|---|---|
| angular-code-quality | `references/` |
| backend-code-quality | `references/` |
| code-quality | `references/` (per-stack rule sets) |
| cost-reducer | — |
| design-prompts | — |
| linkedin-content-coach | — |
| nn-guard | `references/` (generates `.claude/hooks/nn-guard.sh` at install) |
| researcher | — |
| security | — |
| security-audit | — |
| self-healing | — |
| session-logger | — |
| session-restore | — |
| ship-ticket | — |
| spec-driven | `scripts/` (bundled; copied into a project via `setup.sh`) |

Run `ai-skills list` (or `node scripts/cli.mjs list`) for the one-line description of each.

## Layout

```
AI-Skills/
├── skills/<name>/SKILL.md         # + optional references/ and scripts/
├── scripts/
│   ├── cli.mjs                    # cross-platform CLI: list / install / validate
│   ├── install.sh                 # bash installer (Unix) — all or named skills, --copy
│   ├── import.sh                  # optional: pull other installed skills into the repo
│   ├── validate.sh               # bash mirror of the validator (Unix; needs bash ≥ 4)
│   └── package.sh                 # build dist/<name>.skill zips for backup/sharing
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

- `session-logger` / `session-restore` are the current inlined versions (no external scripts).
- `spec-driven` had two dead calls to `session-restore/scripts/restore.sh` and
  `session-logger/scripts/append.sh` (both removed when those skills were inlined). They're replaced
  here with the inline equivalents so the workflow can't exit-127. Its own bundled scripts are untouched.
