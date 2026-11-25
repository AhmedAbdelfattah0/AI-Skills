# Security policy

## Supported version

Only the `main` branch is supported. There are no tagged releases.

## Reporting a vulnerability

Report through the repository's **Security** tab (**Report a vulnerability**) when it is available.
Otherwise open a GitHub issue titled "security contact request" without any details, and the
maintainer will reply with a private channel. Please do not put vulnerability details in a public issue.

## Scope

In scope: the installer and library CLI (`install.sh`, `scripts/cli.mjs`), automatic updates
(`scripts/autoupdate.mjs`), the `ship-ticket` engine scripts, and the hooks and CI jobs the skills
generate (for example `nn-guard`).

Out of scope: the behaviour of third-party model CLIs and providers, and the repositories you point the
skills at.

## Trust notes

- **Auto-update executes upstream code.** The one-line installer schedules a daily job and a session
  hook that run `update --auto` (`git pull --ff-only` of the default branch). Skip it with
  `AI_SKILLS_NO_AUTOUPDATE=1` and run `update` yourself when you have read what changed.
- **Skills direct an agent that has write tools.** Review the plan before approving it; the approval is
  the boundary.
- **Attack rules of engagement are agent rules.** `vapt` is instructed to attack only a local
  disposable instance.
