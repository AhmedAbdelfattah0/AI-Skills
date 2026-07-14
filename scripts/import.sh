#!/usr/bin/env bash
# One-time migration: copy skills that are already installed in ~/.claude/skills
# INTO this repo's skills/ folder, so the repo becomes the single source of truth.
#
# Safe by default: it will NOT overwrite a skill that already exists in the repo
# (e.g. the fixed session-logger / session-restore shipped here). Pass --force to
# overwrite repo copies with the installed ones.
#
#   ./scripts/import.sh           # import only skills not already in the repo
#   ./scripts/import.sh --force   # overwrite repo copies too

set -euo pipefail

FORCE=0
if [ "${1:-}" = "--force" ]; then FORCE=1; fi

SRC="$HOME/.claude/skills"
REPO_SKILLS="$(cd "$(dirname "$0")/../skills" && pwd)"

if [ ! -d "$SRC" ]; then
  echo "No installed skills found at $SRC — nothing to import."
  exit 0
fi

imported=0
skipped=0
for dir in "$SRC"/*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"

  # Skip symlinks: those already point back at a repo, importing them is pointless.
  if [ -L "${dir%/}" ]; then
    echo "↩️  skip '$name' — already a symlink (points at a repo)"
    skipped=$((skipped + 1))
    continue
  fi

  if [ ! -f "$dir/SKILL.md" ]; then
    echo "⚠️  skip '$name' — no SKILL.md"
    skipped=$((skipped + 1))
    continue
  fi

  if [ -e "$REPO_SKILLS/$name" ] && [ "$FORCE" -eq 0 ]; then
    echo "⏭️  keep repo copy of '$name' (use --force to overwrite)"
    skipped=$((skipped + 1))
    continue
  fi

  rm -rf "$REPO_SKILLS/$name"
  cp -R "$dir" "$REPO_SKILLS/$name"
  echo "⬇️  imported $name"
  imported=$((imported + 1))
done

echo ""
echo "✅ imported $imported, skipped $skipped into $REPO_SKILLS"
echo "   next: run ./scripts/validate.sh, then ./scripts/install.sh to symlink back."
