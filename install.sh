#!/usr/bin/env bash
# One-line installer for this skill library:
#
#   curl -fsSL https://raw.githubusercontent.com/AhmedAbdelfattah0/AI-Skills/main/install.sh | bash
#
# It clones (or fast-forwards) the repo into a managed location, symlinks every
# skill into your agents' skills directories, and turns on automatic updates.
# Because the install is symlinked into a clone that stays put, from then on an
# update is just a `git pull` there — which the daily job and the Claude Code
# SessionStart hook do for you.
#
# Environment overrides:
#   AI_SKILLS_HOME=<dir>        where to keep the clone      (default: ~/.ai-skills)
#   AI_SKILLS_REF=<branch|tag>  which ref to install         (default: main)
#   AI_SKILLS_TARGET=<t,..>     which tools to install for   (default: claude)
#                               claude | codex | gemini | agents | antigravity | all
#   AI_SKILLS_NO_AUTOUPDATE=1   install, but do not schedule anything
#
# This script is deliberately thin: it bootstraps, then hands off to
# scripts/cli.mjs, which is the single implementation of install and update.

set -euo pipefail

REPO="https://github.com/AhmedAbdelfattah0/AI-Skills.git"
HOME_DIR="${AI_SKILLS_HOME:-$HOME/.ai-skills}"
REF="${AI_SKILLS_REF:-main}"
TARGET="${AI_SKILLS_TARGET:-claude}"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "❌ this installer needs $1, which is not on your PATH." >&2
    echo "   $2" >&2
    exit 1
  }
}
need git  "Install git, then re-run this command."
need node "Install Node.js 18 or newer (https://nodejs.org), then re-run this command."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "❌ Node $(node -v) is too old; this needs 18 or newer." >&2
  exit 1
fi

# Normalise a remote URL so the scp-form, https-form and a trailing .git compare
# equal — otherwise a legitimate clone looks like a stranger.
normalize_url() {
  printf '%s' "$1" \
    | sed -e 's|^git+||' -e 's|^git@\([^:]*\):|https://\1/|' -e 's|^ssh://git@|https://|' \
          -e 's|\.git$||' -e 's|/*$||' \
    | tr '[:upper:]' '[:lower:]'
}

# HTTPS, not SSH: a fresh machine has no key loaded, and this must work there.
if [ -d "$HOME_DIR/.git" ]; then
  # WHOSE repository is this? Below, this script fetches it and then EXECUTES its
  # scripts/cli.mjs. An installer that promises one repository must not run code
  # from whatever else happens to be sitting at that path — so the origin is
  # checked before anything is fetched and long before anything is run.
  EXISTING="$(git -C "$HOME_DIR" remote get-url origin 2>/dev/null || true)"
  if [ "$(normalize_url "$EXISTING")" != "$(normalize_url "$REPO")" ]; then
    echo "❌ $HOME_DIR is a git repository, but its origin is not this project." >&2
    echo "   found:    ${EXISTING:-<no origin remote>}" >&2
    echo "   expected: $REPO" >&2
    echo "   Refusing to fetch or run code from it. Move it aside, or set" >&2
    echo "   AI_SKILLS_HOME=<another dir> and re-run." >&2
    exit 1
  fi
  echo "📦 updating $HOME_DIR"
  # Never fast-forward over uncommitted work; say so and use the tree as it is.
  if [ -n "$(git -C "$HOME_DIR" status --porcelain)" ]; then
    echo "   (uncommitted changes there — not pulling; using it as it stands)"
  else
    git -C "$HOME_DIR" fetch --quiet origin "$REF"
    git -C "$HOME_DIR" checkout --quiet "$REF"
    git -C "$HOME_DIR" merge --ff-only --quiet "origin/$REF" 2>/dev/null \
      || echo "   (could not fast-forward — leaving $HOME_DIR as it stands)"
  fi
elif [ -e "$HOME_DIR" ]; then
  echo "❌ $HOME_DIR exists but is not a git repository. Refusing to touch it." >&2
  echo "   Move it aside, or set AI_SKILLS_HOME=<another dir> and re-run." >&2
  exit 1
else
  echo "📦 cloning into $HOME_DIR"
  git clone --quiet --branch "$REF" "$REPO" "$HOME_DIR"
fi

echo
node "$HOME_DIR/scripts/cli.mjs" install --link --target "$TARGET"

if [ "${AI_SKILLS_NO_AUTOUPDATE:-}" = "1" ]; then
  echo "   (AI_SKILLS_NO_AUTOUPDATE=1 — nothing scheduled; run \"update\" yourself.)"
else
  echo
  node "$HOME_DIR/scripts/cli.mjs" autoupdate --install
fi

echo
echo "✅ done. The skills are symlinked into your agents' skills directories,"
echo "   so anything that reaches $HOME_DIR is live immediately."
echo "   node $HOME_DIR/scripts/cli.mjs list      — see what you have"
echo "   node $HOME_DIR/scripts/cli.mjs autoupdate — check automatic updates"
