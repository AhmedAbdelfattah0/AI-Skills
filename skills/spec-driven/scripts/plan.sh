#!/usr/bin/env bash
# spec-driven/scripts/plan.sh
# Usage: plan.sh "<FEATURE_DIR>"
#
# Claude writes plan content to .claude/skills/spec-driven/scripts/.plan.tmp BEFORE calling this.
# .plan.tmp format — sections delimited by ---SECTION--- markers:
# ---STACK---
# | Concern | Decision | Rationale |
# ...
# ---FOLDER_STRUCTURE---
# src/app/features/...
# ---SIGNALS---
# ...
# ---REPOSITORY---
# ...
# ---MODELS---
# ...
# ---ROUTING---
# ...
# ---UI_NOTES---
# ...
# ---SSR_GUARDS---
# ...
# ---RTL_NOTES---
# ...
# ---RISKS---
# ...
#
# TEMPLATE (fallback): write plan.md directly using sections above

FEATURE_DIR="${1}"
DATE=$(date "+%Y-%m-%d")
OUT="$FEATURE_DIR/plan.md"
TMP=".claude/skills/spec-driven/scripts/.plan.tmp"

# Guard: clarify must exist
if [ ! -f "$FEATURE_DIR/clarify.md" ]; then
  echo "❌ clarify.md not found in ${FEATURE_DIR}. Run /spec.clarify first."
  exit 1
fi

# Guard: tmp must exist
if [ ! -f "$TMP" ]; then
  echo "❌ Plan temp file not found at ${TMP}."
  echo "   Claude must write plan content to ${TMP} before calling this script."
  exit 1
fi

PROJECT_TYPE=$(grep "^\*\*Project Type\*\*" .spec/constitution.md 2>/dev/null | sed 's/.*| //')
UI_FRAMEWORK=$(grep "^\*\*UI Framework\*\*" .spec/constitution.md 2>/dev/null | sed 's/.*| //')

# Parse sections
parse_section() {
  awk "/^---${1}---/{found=1; next} found && /^---/{exit} found{print}" "$TMP"
}

STACK=$(parse_section "STACK")
FOLDER=$(parse_section "FOLDER_STRUCTURE")
SIGNALS=$(parse_section "SIGNALS")
REPOSITORY=$(parse_section "REPOSITORY")
MODELS=$(parse_section "MODELS")
ROUTING=$(parse_section "ROUTING")
UI_NOTES=$(parse_section "UI_NOTES")
SSR=$(parse_section "SSR_GUARDS")
RTL=$(parse_section "RTL_NOTES")
RISKS=$(parse_section "RISKS")

rm "$TMP"

cat > "$OUT" << PLAN
# Technical Plan: $(basename $FEATURE_DIR)
> Project Type: ${PROJECT_TYPE}
> UI Framework: ${UI_FRAMEWORK}
> Date: ${DATE}

---

## Tech Stack

${STACK}

---

## Folder Structure

\`\`\`
${FOLDER}
\`\`\`

---

## Signal Store Design

${SIGNALS}

---

## Repository Service

${REPOSITORY}

---

## Model Definitions

${MODELS}

---

## Routing

${ROUTING}

---

## UI Components

${UI_NOTES}

---

## SSR Safety

${SSR}

---

## RTL Considerations

${RTL}

---

## Risks & Mitigations

${RISKS}
PLAN

echo "✅ Plan written to ${OUT}"
