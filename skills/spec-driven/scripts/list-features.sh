#!/usr/bin/env bash
# spec-driven/scripts/list-features.sh
# Usage: list-features.sh
# Prints available feature directories with their current status

FEATURES_DIR=".spec/features"

if [ ! -d "$FEATURES_DIR" ]; then
  echo "NO_FEATURES"
  exit 0
fi

COUNT=$(ls -d "$FEATURES_DIR"/*/ 2>/dev/null | wc -l | tr -d ' ')

if [ "$COUNT" = "0" ]; then
  echo "NO_FEATURES"
  exit 0
fi

echo "FEATURE_COUNT=${COUNT}"
echo ""

for dir in "$FEATURES_DIR"/*/; do
  NAME=$(basename "$dir")
  HAS_SPEC=$([ -f "$dir/spec.md" ] && echo "✅" || echo "⬜")
  HAS_CLARIFY=$([ -f "$dir/clarify.md" ] && echo "✅" || echo "⬜")
  HAS_PLAN=$([ -f "$dir/plan.md" ] && echo "✅" || echo "⬜")
  HAS_TASKS=$([ -f "$dir/tasks.md" ] && echo "✅" || echo "⬜")

  # Get task progress if tasks.md exists
  if [ -f "$dir/tasks.md" ]; then
    DONE=$(grep -c "✅ Done" "$dir/tasks.md" 2>/dev/null || echo 0)
    TOTAL=$(grep -c "⬜ Not started\|✅ Done" "$dir/tasks.md" 2>/dev/null || echo 0)
    PROGRESS=" [${DONE}/${TOTAL} tasks done]"
  else
    PROGRESS=""
  fi

  echo "${NAME} | spec:${HAS_SPEC} clarify:${HAS_CLARIFY} plan:${HAS_PLAN} tasks:${HAS_TASKS}${PROGRESS}"
done
