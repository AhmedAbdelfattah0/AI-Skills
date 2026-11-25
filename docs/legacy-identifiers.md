# Legacy identifiers

The repository was renamed from `AI-Skills` to `agentic-software-factory`. The old URL redirects.
The following identifiers keep their original names so existing installs, scheduled jobs and state
keep working. They are compatibility surface, not the project name.

| Identifier | Where | Meaning |
|---|---|---|
| `ai-skills` | `package.json` `bin`, CLI name in help output | The CLI command name (`npm link` provides it). |
| `~/.ai-skills` | `install.sh`, `AI_SKILLS_HOME` | Default clone location for the one-line installer. |
| `ai-skills/ship-ticket/` | Under the repository's Git common directory | Run state, telemetry and sprint queue files for `ship-ticket`. |
| `.ai-skills-manifest.json` | Beside installed skills | Records what the installer put there; the baseline `update` compares against. |
| `.ai-skills-tmp/` | Inside a skills directory | Staging area for build-then-swap installs. |
| `com.ai-skills.update` | `scripts/autoupdate.mjs` | launchd label of the daily update job. |
| `AI_SKILLS_*` | `install.sh` | Environment overrides for the one-line installer. |
| `~/.local/state/ai-skills/` | Installer | Backups of entries that were replaced on request. |
| `AI-Skills` URL in `install.sh` and `package.json` | Repository metadata | The old clone URL, still valid through GitHub's redirect. |

Renaming these is a separate decision with migration concerns (existing manifests, scheduled jobs and
state paths) and is not part of the documentation redesign.

## npm names

`ai-skills` and `ai-agent-skills` on the npm registry are published by other people. This project is
installed from GitHub, not from the npm registry. Install only through the forms in [installation.md](installation.md).
