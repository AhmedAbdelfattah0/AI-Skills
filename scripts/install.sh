#!/usr/bin/env bash
# Install skills from this repo into ~/.claude/skills (macOS / Linux / Git Bash / WSL).
# The cross-platform equivalent is `node scripts/cli.mjs install` — see README.
#
#   ./scripts/install.sh                     # all skills, symlinked (edits go live instantly)
#   ./scripts/install.sh security researcher # only the named skills
#   ./scripts/install.sh --copy              # all skills, real files (no symlink)
#   ./scripts/install.sh --copy security     # named skills, real files
#
# Symlink mode is best on your primary machine: one `git pull` / edit and Claude
# Code sees the change with no re-install. Copy mode is for machines where the
# repo path may differ or symlinks aren't wanted.

set -euo pipefail

MODE="link"
NAMES=()
for arg in "$@"; do
  case "$arg" in
    --copy) MODE="copy" ;;
    --link) MODE="link" ;;
    -*) echo "unknown flag: $arg" >&2; exit 1 ;;
    *) NAMES+=("$arg") ;;
  esac
done

REPO_SKILLS="$(cd "$(dirname "$0")/../skills" && pwd)"
DEST="$HOME/.claude/skills"
mkdir -p "$DEST"

# Build the target list: named skills if given, else every skill folder.
TARGETS=()
if [ "${#NAMES[@]}" -gt 0 ]; then
  for name in "${NAMES[@]}"; do
    if [ ! -f "$REPO_SKILLS/$name/SKILL.md" ]; then
      echo "❌ unknown skill: $name (run ./scripts/install.sh with no args to see them, or 'node scripts/cli.mjs list')" >&2
      exit 1
    fi
    TARGETS+=("$name")
  done
else
  for dir in "$REPO_SKILLS"/*/; do
    [ -f "$dir/SKILL.md" ] && TARGETS+=("$(basename "$dir")")
  done
fi

count=0
for name in "${TARGETS[@]}"; do
  dir="$REPO_SKILLS/$name"
  rm -rf "$DEST/$name"
  if [ "$MODE" = "link" ]; then
    ln -s "$dir" "$DEST/$name"
    echo "🔗 linked  $name"
  else
    cp -R "$dir" "$DEST/$name"
    echo "📄 copied  $name"
  fi
  count=$((count + 1))
done

echo ""
echo "✅ installed $count skill(s) into $DEST  (mode: $MODE)"
[ "$MODE" = "link" ] && echo "   edits in $REPO_SKILLS are now live in Claude Code."
