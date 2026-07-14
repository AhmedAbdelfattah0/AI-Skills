#!/usr/bin/env bash
# spec-driven/scripts/design.sh
# Usage: design.sh "<FEATURE_DIR>"
#
# Claude writes extracted design values to .claude/skills/spec-driven/scripts/.design.tmp
# BEFORE calling this script. This script assembles design.md from that temp file.
#
# .design.tmp format — sections delimited by ---SECTION--- markers:
# ---COMPONENTS---    List of components + shared component mappings
# ---TYPOGRAPHY---    Per-element: font-family | weight | size | color | transform
# ---COLORS---        name | hex | used for
# ---SPACING---       zone | padding | margin | gap (exact px)
# ---LAYOUT---        grid/flex | columns | breakpoints | sticky
# ---SIZING---        element | width | height
# ---STATES---        element | hover | active | disabled | empty
# ---MOBILE---        breakpoint | layout changes
#
# TEMPLATE (fallback if script not found):
# Write design.md directly using sections above — exact values only, no approximations

FEATURE_DIR="${1}"
DATE=$(date "+%Y-%m-%d")
OUT="$FEATURE_DIR/design.md"
TMP=".claude/skills/spec-driven/scripts/.design.tmp"

# Guard: clarify must exist
if [ ! -f "$FEATURE_DIR/clarify.md" ]; then
  echo "❌ clarify.md not found in ${FEATURE_DIR}. Run /spec.clarify first."
  exit 1
fi

# Guard: tmp must exist
if [ ! -f "$TMP" ]; then
  echo "❌ Design temp file not found at ${TMP}."
  echo "   Claude must extract design values from Stitch and write to ${TMP} first."
  exit 1
fi

FEATURE_NAME=$(basename "$FEATURE_DIR")
PROJECT_TYPE=$(grep "^\*\*Project Type\*\*" .spec/constitution.md 2>/dev/null | sed 's/.*| //')
UI_FRAMEWORK=$(grep "^\*\*UI Framework\*\*" .spec/constitution.md 2>/dev/null | sed 's/.*| //')

# Parse sections
parse_section() {
  awk "/^---${1}---/{found=1; next} found && /^---/{exit} found{print}" "$TMP"
}

COMPONENTS=$(parse_section "COMPONENTS")
TYPOGRAPHY=$(parse_section "TYPOGRAPHY")
COLORS=$(parse_section "COLORS")
SPACING=$(parse_section "SPACING")
LAYOUT=$(parse_section "LAYOUT")
SIZING=$(parse_section "SIZING")
STATES=$(parse_section "STATES")
MOBILE=$(parse_section "MOBILE")

rm "$TMP"

cat > "$OUT" << DESIGN
# Design Spec: ${FEATURE_NAME}
> Source: Stitch / Figma
> Project Type: ${PROJECT_TYPE} | UI Framework: ${UI_FRAMEWORK}
> Date: ${DATE}
> ⚠️ These are locked values — do not approximate during implementation.

---

## Components Map

${COMPONENTS}

---

## Typography

${TYPOGRAPHY}

---

## Colors

${COLORS}

---

## Spacing

${SPACING}

---

## Layout

${LAYOUT}

---

## Sizing

${SIZING}

---

## States (hover / active / disabled / empty)

${STATES}

---

## Mobile

${MOBILE}

---

## Implementation Rules

- Every CSS value in tasks must match this document exactly
- If a value is not listed here, check Stitch again — do not guess
- Flag any discrepancy between design.md and constitution.md as a VIOLATION
DESIGN

echo "✅ Design spec written to ${OUT}"
