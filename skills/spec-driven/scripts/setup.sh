#!/usr/bin/env bash
# spec-driven/scripts/setup.sh
# Copies spec-driven scripts into the current project's .claude/skills/ folder.
# Run once per project from the project root.

TARGET=".claude/skills/spec-driven/scripts"

# Find the installed skill — check common locations in order
find_skill_scripts() {
  # 1. Already in the right place (re-run of setup)
  [ -f ".claude/skills/spec-driven/scripts/specify.sh" ] && \
    echo ".claude/skills/spec-driven/scripts" && return

  # 2. Claude Code global install (mac/linux)
  [ -d "$HOME/.claude/skills/spec-driven/scripts" ] && \
    echo "$HOME/.claude/skills/spec-driven/scripts" && return

  # 3. Claude Code project-level install
  [ -d ".claude/skills/spec-driven/scripts" ] && \
    echo ".claude/skills/spec-driven/scripts" && return

  # 4. Same directory as this script (running from extracted bundle)
  SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  [ -d "$SELF_DIR" ] && echo "$SELF_DIR" && return

  echo "NOT_FOUND"
}

SOURCE=$(find_skill_scripts)

if [ "$SOURCE" = "NOT_FOUND" ]; then
  echo "❌ Could not locate spec-driven scripts."
  echo "   Expected at: ~/.claude/skills/spec-driven/scripts/"
  echo "   Make sure you ran: claude skills install angular-spec-bundle.skill"
  exit 1
fi

if [ "$SOURCE" = "$TARGET" ]; then
  echo "✅ Scripts already installed at $TARGET"
  exit 0
fi

echo "📦 Installing spec-driven scripts..."
echo "   Source: $SOURCE"
echo "   Target: $TARGET"

mkdir -p "$TARGET"
cp "$SOURCE/"*.sh "$TARGET/"
chmod +x "$TARGET/"*.sh

echo ""
echo "✅ Done. Scripts installed:"
ls "$TARGET/"
echo ""
echo "You can now run /spec.constitution to begin."
