#!/usr/bin/env bash
# Install every skill in this repo into ~/.claude/skills.
#
#   ./scripts/install.sh          # symlink mode (default) — edits in the repo go live instantly
#   ./scripts/install.sh --copy   # copy mode — real files, for machines you don't want symlinked
#
# Symlink mode is best on your primary machine: one `git pull` / edit and Claude
# Code sees the change with no re-install. Copy mode is for secondary machines
# where the repo path may differ.

set -euo pipefail

MODE="link"
if [ "${1:-}" = "--copy" ]; then MODE="copy"; fi

REPO_SKILLS="$(cd "$(dirname "$0")/../skills" && pwd)"
DEST="$HOME/.claude/skills"
mkdir -p "$DEST"

count=0
for dir in "$REPO_SKILLS"/*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"

  # A valid skill folder must contain a SKILL.md
  if [ ! -f "$dir/SKILL.md" ]; then
    echo "⚠️  skipping '$name' — no SKILL.md"
    continue
  fi

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
