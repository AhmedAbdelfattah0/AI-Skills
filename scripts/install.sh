#!/usr/bin/env bash
# Install skills from this repo (macOS / Linux / Git Bash / WSL).
# The cross-platform equivalent is `node scripts/cli.mjs install` — see README.
#
# SKILL.md is an open standard, so the same skills install into any compliant
# tool — only the destination directory differs. Pick it with --target:
#
#   claude   ~/.claude/skills    Claude Code (default)
#   codex    ~/.agents/skills    OpenAI Codex
#   gemini   ~/.gemini/skills    Gemini CLI (also reads ~/.agents/skills)
#   agents   ~/.agents/skills    any standard-compliant tool
#   all      claude + agents + gemini
#
#   ./scripts/install.sh                          # all skills → Claude Code, symlinked
#   ./scripts/install.sh security researcher      # only the named skills
#   ./scripts/install.sh --copy                   # real files instead of symlinks
#   ./scripts/install.sh --target codex           # all skills → OpenAI Codex
#   ./scripts/install.sh --target all security    # one skill → every tool
#   ./scripts/install.sh --dest /path/to/skills   # custom destination directory
#
# Symlink mode is best on your primary machine: one `git pull` / edit and every
# linked tool sees the change with no re-install. Copy mode is for machines
# where the repo path may differ or symlinks aren't wanted.

set -euo pipefail

MODE="link"
TARGET_SPEC=""
DEST_OVERRIDE=""
NAMES=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --copy) MODE="copy" ;;
    --link) MODE="link" ;;
    --target|-t) TARGET_SPEC="${2:-}"; shift ;;
    --target=*) TARGET_SPEC="${1#--target=}" ;;
    --dest) DEST_OVERRIDE="${2:-}"; shift ;;
    --dest=*) DEST_OVERRIDE="${1#--dest=}" ;;
    -*) echo "unknown flag: $1" >&2; exit 1 ;;
    *) NAMES+=("$1") ;;
  esac
  shift
done

REPO_SKILLS="$(cd "$(dirname "$0")/../skills" && pwd)"

# Map a target name to its destination directory (bash-3.2 safe: no assoc arrays).
target_dir() {
  case "$1" in
    claude) echo "$HOME/.claude/skills" ;;
    codex|agents) echo "$HOME/.agents/skills" ;;
    gemini) echo "$HOME/.gemini/skills" ;;
    *) echo "" ;;
  esac
}

# Resolve destination dirs (deduped — codex and agents share a dir).
DEST_DIRS=()
DEST_LABELS=()
add_dest() { # $1=label $2=dir — skip if the dir is already queued
  local d
  for d in ${DEST_DIRS[@]+"${DEST_DIRS[@]}"}; do [ "$d" = "$2" ] && return; done
  DEST_LABELS+=("$1"); DEST_DIRS+=("$2")
}
if [ -n "$DEST_OVERRIDE" ]; then
  add_dest "custom" "$DEST_OVERRIDE"
else
  [ -z "$TARGET_SPEC" ] && TARGET_SPEC="claude"
  [ "$TARGET_SPEC" = "all" ] && TARGET_SPEC="claude,agents,gemini"
  IFS=',' read -r -a KEYS <<< "$TARGET_SPEC"
  for key in "${KEYS[@]}"; do
    key="$(echo "$key" | tr -d '[:space:]')"
    [ -z "$key" ] && continue
    dir="$(target_dir "$key")"
    if [ -z "$dir" ]; then
      echo "❌ unknown target: $key (valid: claude, codex, gemini, agents, all — or use --dest <path>)" >&2
      exit 1
    fi
    add_dest "$key" "$dir"
  done
fi

# Build the skill list: named skills if given, else every skill folder.
TARGETS=()
if [ "${#NAMES[@]}" -gt 0 ]; then
  for name in "${NAMES[@]}"; do
    if [ ! -f "$REPO_SKILLS/$name/SKILL.md" ]; then
      echo "❌ unknown skill: $name (run 'node scripts/cli.mjs list' or ls skills/)" >&2
      exit 1
    fi
    TARGETS+=("$name")
  done
else
  for dir in "$REPO_SKILLS"/*/; do
    [ -f "$dir/SKILL.md" ] && TARGETS+=("$(basename "$dir")")
  done
fi

i=0
for DEST in "${DEST_DIRS[@]}"; do
  LABEL="${DEST_LABELS[$i]}"
  i=$((i + 1))
  mkdir -p "$DEST"
  count=0
  for name in "${TARGETS[@]}"; do
    dir="$REPO_SKILLS/$name"
    rm -rf "$DEST/$name"
    if [ "$MODE" = "link" ]; then
      ln -s "$dir" "$DEST/$name"
      echo "🔗 linked  $name  → $LABEL"
    else
      cp -R "$dir" "$DEST/$name"
      echo "📄 copied  $name  → $LABEL"
    fi
    count=$((count + 1))
  done
  echo ""
  echo "✅ [$LABEL] installed $count skill(s) into $DEST  (mode: $MODE)"
  echo ""
done
[ "$MODE" = "link" ] && echo "   edits in $REPO_SKILLS are live everywhere they're linked."
