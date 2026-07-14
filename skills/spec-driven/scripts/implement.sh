#!/usr/bin/env bash
# spec-driven/scripts/implement.sh
# Usage:
#   --check "<FEATURE_DIR>"              → guard check, prints task list
#   --done  "<FEATURE_DIR>" "<TASK_ID>"  → marks task as [DONE] in tasks.md

MODE="${1}"
FEATURE_DIR="${2}"

if [ "$MODE" = "--check" ]; then
  if [ ! -f "$FEATURE_DIR/tasks.md" ]; then
    echo "❌ tasks.md not found in ${FEATURE_DIR}. Run /spec.tasks first."
    exit 1
  fi
  echo "✅ Guard passed. Active feature: $(basename $FEATURE_DIR)"
  echo ""
  echo "=== TASK LIST ==="
  grep "^### Task\|^- \[ \]\|^\*\*File:\*\*\|\[DONE\]\|⚠️" "$FEATURE_DIR/tasks.md"
  echo "================="
  exit 0
fi

if [ "$MODE" = "--done" ]; then
  TASK_ID="${3}"
  TASKS_FILE="$FEATURE_DIR/tasks.md"

  if [ ! -f "$TASKS_FILE" ]; then
    echo "❌ tasks.md not found."
    exit 1
  fi

  # Mark task header as DONE
  sed -i "s/^### Task ${TASK_ID} /### Task ${TASK_ID} [DONE] /" "$TASKS_FILE"

  # Mark checkboxes under this task as checked
  # (marks the next block of unchecked boxes until next task header)
  awk -v id="Task ${TASK_ID}" '
    /^### Task/ { in_task = ($0 ~ id) }
    in_task && /^- \[ \]/ { sub(/\[ \]/, "[x]") }
    { print }
  ' "$TASKS_FILE" > "$TASKS_FILE.tmp" && mv "$TASKS_FILE.tmp" "$TASKS_FILE"

  # Update progress tracker row
  sed -i "s/| ${TASK_ID}.*| ⬜ Not started |/| ${TASK_ID} | ✅ Done |/" "$TASKS_FILE"

  echo "✅ Task ${TASK_ID} marked as DONE in $(basename $FEATURE_DIR)/tasks.md"

  # Check if all tasks done
  REMAINING=$(grep "⬜ Not started" "$TASKS_FILE" | wc -l | tr -d ' ')
  if [ "$REMAINING" = "0" ]; then
    echo "🎉 All tasks complete! Session logger will now run."
    exit 2  # Exit code 2 = signal to SKILL.md to trigger session-logger
  fi

  echo "Remaining tasks: ${REMAINING}"
  exit 0
fi

echo "❌ Usage: implement.sh --check <dir> | --done <dir> <task_id>"
exit 1
