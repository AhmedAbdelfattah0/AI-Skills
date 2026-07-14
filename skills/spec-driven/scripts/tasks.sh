#!/usr/bin/env bash
# spec-driven/scripts/tasks.sh
# Usage: tasks.sh "<FEATURE_DIR>" "<VIOLATIONS>"
#
# Claude writes tasks to .claude/skills/spec-driven/scripts/.tasks.tmp BEFORE calling this script.
# Each task block is written as proper markdown — no argument passing for task content.
#
# .tasks.tmp format (Claude writes this file):
# ### Task T01 — Title
# **File:** path/to/file.ts
# **Depends on:** none
# **Parallel:** no
# **Acceptance Criteria:**
# - [ ] Criterion one
# - [ ] Criterion two
#
# ### Task T02 — Title
# ...
#
# TEMPLATE (fallback if script not found):
# Write tasks.md directly using the format above

FEATURE_DIR="${1}"
VIOLATIONS="${2}"

DATE=$(date "+%Y-%m-%d")
OUT="$FEATURE_DIR/tasks.md"
TMP=".claude/skills/spec-driven/scripts/.tasks.tmp"

# Guard: plan must exist
if [ ! -f "$FEATURE_DIR/plan.md" ]; then
  echo "❌ plan.md not found in ${FEATURE_DIR}. Run /spec.plan first."
  exit 1
fi

# Guard: tmp tasks file must exist
if [ ! -f "$TMP" ]; then
  echo "❌ Tasks temp file not found at ${TMP}."
  echo "   Claude must write task content to ${TMP} before calling this script."
  exit 1
fi

FEATURE_NAME=$(basename "$FEATURE_DIR")
PROJECT_TYPE=$(grep "^\*\*Project Type\*\*" .spec/constitution.md 2>/dev/null | sed 's/.*| //')

# Violation block
if [ -z "$VIOLATIONS" ] || [ "$VIOLATIONS" = "none" ]; then
  VIOLATION_BLOCK="No violations detected. Constitution compliance confirmed."
else
  VIOLATION_BLOCK="$VIOLATIONS"
fi

# Write header
cat > "$OUT" << HEADER
# Tasks: ${FEATURE_NAME}
> Project Type: ${PROJECT_TYPE}
> Status: Not Started
> Date: ${DATE}

---

## Legend

- \`[P]\` — Parallel safe within same phase
- \`[DONE]\` — Completed
- \`⚠️ VIOLATION\` — Breaks constitution (do not implement)

---

## Tasks

HEADER

# Append tasks from temp file (preserves all formatting and newlines)
cat "$TMP" >> "$OUT"
rm "$TMP"

# Write violations and progress tracker
cat >> "$OUT" << FOOTER

---

## VIOLATION Alerts

${VIOLATION_BLOCK}

---

## Progress Tracker

| Task | Status |
|---|---|
FOOTER

# Auto-generate progress rows from task headers
grep "^### Task" "$OUT" | while read -r line; do
  TASK_ID=$(echo "$line" | sed 's/### Task //' | awk '{print $1}')
  TASK_TITLE=$(echo "$line" | sed 's/### Task [^ ]* — //' | sed 's/ \[P\]//')
  echo "| ${TASK_ID} — ${TASK_TITLE} | ⬜ Not started |" >> "$OUT"
done

echo "" >> "$OUT"
echo "✅ Tasks written to ${OUT}"
