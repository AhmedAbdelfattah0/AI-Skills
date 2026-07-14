#!/usr/bin/env bash
# spec-driven/scripts/specify.sh
# Usage: specify.sh "<FEATURE_NAME>"
#
# Claude writes spec content to .claude/skills/spec-driven/scripts/.specify.tmp BEFORE calling this.
# .specify.tmp format:
# OVERVIEW: <one paragraph>
# ---STORIES---
# <user stories markdown>
# ---REQUIREMENTS---
# <functional requirements markdown>
# ---OUT_OF_SCOPE---
# <out of scope list>
# ---OPEN_QUESTIONS---
# <open questions list>
#
# TEMPLATE (fallback if script not found):
# Write .spec/features/NNN-name/spec.md directly using sections above

FEATURE_NAME="${1}"
DATE=$(date "+%Y-%m-%d")
FEATURES_DIR=".spec/features"
TMP=".claude/skills/spec-driven/scripts/.specify.tmp"

# Guard: constitution must exist
if [ ! -f ".spec/constitution.md" ]; then
  echo "❌ .spec/constitution.md not found. Run /spec.constitution first."
  exit 1
fi

# Guard: tmp file must exist
if [ ! -f "$TMP" ]; then
  echo "❌ Spec temp file not found at ${TMP}."
  echo "   Claude must write spec content to ${TMP} before calling this script."
  exit 1
fi

# Auto-increment feature number
mkdir -p "$FEATURES_DIR"
COUNT=$(ls -d "$FEATURES_DIR"/*/ 2>/dev/null | wc -l | tr -d ' ')
NUM=$(printf "%03d" $((COUNT + 1)))
FEATURE_DIR="$FEATURES_DIR/${NUM}-${FEATURE_NAME}"
mkdir -p "$FEATURE_DIR"
OUT="$FEATURE_DIR/spec.md"

# Parse sections from tmp file
OVERVIEW=$(awk '/^OVERVIEW:/{found=1; sub(/^OVERVIEW: /,""); print; next} found && /^---/{exit} found{print}' "$TMP")
STORIES=$(awk '/^---STORIES---/{found=1; next} found && /^---/{exit} found{print}' "$TMP")
REQUIREMENTS=$(awk '/^---REQUIREMENTS---/{found=1; next} found && /^---/{exit} found{print}' "$TMP")
OUT_OF_SCOPE=$(awk '/^---OUT_OF_SCOPE---/{found=1; next} found && /^---/{exit} found{print}' "$TMP")
OPEN_QUESTIONS=$(awk '/^---OPEN_QUESTIONS---/{found=1; next} found && /^---/{exit} found{print}' "$TMP")

rm "$TMP"

cat > "$OUT" << SPEC
# Feature Spec: ${FEATURE_NAME}
> Feature: ${NUM}-${FEATURE_NAME}
> Status: Draft
> Date: ${DATE}

---

## Overview

${OVERVIEW}

---

## User Stories

${STORIES}

---

## Functional Requirements

${REQUIREMENTS}

---

## Out of Scope

${OUT_OF_SCOPE}

---

## Open Questions

${OPEN_QUESTIONS}

---

## Success Metrics

- [ ] All acceptance criteria in user stories pass
- [ ] Feature works in all markets defined in constitution
SPEC

echo "✅ Spec written to ${OUT}"
echo "FEATURE_DIR=${FEATURE_DIR}"
