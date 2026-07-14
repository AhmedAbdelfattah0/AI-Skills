# AI-Skills

A shareable library of [Claude Code](https://claude.com/claude-code) skills. Each skill lives in
`skills/<name>/` with a `SKILL.md` (plus optional `references/` or `scripts/`). Installing puts each
skill into `~/.claude/skills/` where Claude Code picks it up automatically.

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
```

From a clone, skills are **symlinked** by default, so `git pull` (or editing a `SKILL.md`) updates what
Claude Code sees with no re-install. Use `--copy` if you'd rather have real files. On **Windows** the
CLI creates directory *junctions* (no admin rights needed); if a symlink is ever refused, add `--copy`.

> **Optional:** run `npm link` in the clone to get an `ai-skills` command on your PATH, then use
> `ai-skills install …` anywhere instead of `node scripts/cli.mjs …`.

### Option C — bash installer (macOS / Linux / Git Bash / WSL)

Same behaviour as Option B, no Node required:

```bash
./scripts/install.sh                     # all skills, symlinked
./scripts/install.sh security researcher # only these
./scripts/install.sh --copy              # all skills, real files
```

### Verify

After installing, run `/skills` (or restart) in Claude Code and confirm the skills appear.

## Skills (15)

Most skills **trigger automatically** when Claude notices a matching task; a few are driven by explicit
slash commands. Each entry below says what it's for and how to reach it. Run
`ai-skills list` (or `node scripts/cli.mjs list`) for the raw one-line descriptions.

### Code quality & architecture

- **code-quality** — Stack-agnostic quality baseline. Interviews you about your stack and writes a
  `.code-quality.md` "constitution" to the project root that every future session obeys.
  *How to use:* `/cq.init` to set up, `/cq.load` to reload, `/cq.update` to revise; also auto-triggers
  when you start coding in a project that has no `.code-quality.md`.
- **angular-code-quality** — Enforces SOLID + MVVM + Signals conventions and project patterns for
  Angular/TypeScript work (reads `CLAUDE.md` first). Ships per-stack rule sets and design-fidelity
  guidance in `references/`. *How to use:* auto-applies whenever you create, refactor, or review
  Angular components, services, or features.
- **backend-code-quality** — Security-first backend patterns for any language/runtime: tenant
  isolation, input validation, webhook safety, audit integrity, SOLID. Detects your stack and reads
  `CLAUDE.md`. *How to use:* auto-applies on routes, handlers, middleware, migrations, webhooks, and DB
  access.
- **nn-guard** — Enforces code-quality's `[NN]` rules *deterministically, outside the model*: installs
  a Claude Code PostToolUse hook that checks every edit plus a CI job that fails the PR on the same
  rules. *How to use:* `/guard.install`, `/guard.check`, `/guard.status`, `/guard.ci`.
- **cost-reducer** — Finds and applies cost savings across AI agents, SaaS, cloud infra, and code
  (token usage, serverless, storage, cheaper service alternatives). *How to use:* auto-triggers on
  cost/spend topics, or ask it to review your architecture for savings.

### Security

- **security** — Baseline "don't ship a vulnerability" practices for fast/vibecoded apps: auth,
  secrets/env vars, DB queries, API endpoints, file uploads. *How to use:* auto-applies on any
  security-sensitive code, even when you don't ask.
- **security-audit** — Reasoning-based, wave-scanning security audit for Angular/web projects that
  minimizes token burn and turns findings into tracked tasks under `.specs/security-audit/`. Works in
  Claude Code (reads disk) or claude.ai chat (paste mode). *How to use:* `/sec.audit`, then
  `/sec.specify` → `/sec.plan` → `/sec.tasks` → `/sec.implement`, plus `/sec.fix <N>` for a single finding.

### Planning & delivery

- **spec-driven** — A six-step, gated spec-driven workflow for Angular + MVVM + Signals; bundled
  `scripts/` create the artifact files while Claude only fills in content. *How to use:*
  `/spec.constitution` → `/spec.specify` → `/spec.clarify` → `/spec.plan` → `/spec.tasks` →
  `/spec.implement` (run `setup.sh` once per project to copy the scripts in).
- **ship-ticket** — Implements a Jira ticket end-to-end: locked stack + SOLID, design-source-of-truth
  read, a CI-enforced design-parity gate, two-pass review, and full close-out (PR + Jira Done + session
  log). *How to use:* `/ship-ticket <TICKET-KEY>` (e.g. `/ship-ticket SCRUM-28`).
- **design-prompts** — Generates structured design prompts for any digital product in two modes:
  GREENFIELD (a numbered prompt set for a whole design system) or UPDATE (one focused prompt to add or
  change a single feature). *How to use:* `/design.prompts`.

### Session continuity & self-improvement

- **session-logger** — Appends a structured summary (context, decisions, files changed, next steps) to
  `session-log.md` so continuity survives between sessions. *How to use:* `/summarize`, `/log`, or
  `/session` at the end of a session.
- **session-restore** — The other half of continuity: reads the latest `session-log.md` entry to
  restore context. *How to use:* auto-runs at the start of a new session, or say "let's continue" /
  `/restore`.
- **self-healing** — Teaches Claude to learn from mistakes — recognize recurring failures and update
  its own skills/guidelines; also the guide for authoring `SKILL.md` files. *How to use:* auto-triggers
  on repeated corrections or task failures, and when creating/editing a skill.
- **researcher** — Forces thorough research and verification before claims or tech decisions (does this
  library/API exist, is it maintained, what are the current best practices). *How to use:* auto-triggers
  when investigating libraries, comparing frameworks, or before any claim that could be outdated.

### Content

- **linkedin-content-coach** — Rewrites LinkedIn posts (tuned for MENA-region devs/engineers): analyzes
  the post, fixes the hook, and returns an algorithm-optimized version. *How to use:*
  `/linkedin-content-coach <your post>`.

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
