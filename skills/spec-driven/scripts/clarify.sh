#!/usr/bin/env bash
# spec-driven/scripts/clarify.sh
# Usage:
#   --read  "<FEATURE_DIR>"                          → prints spec.md for Claude to read
#   --write "<FEATURE_DIR>" "<API>" "<UX>" "<STATE>" "<RTL>" "<PERF>"  → writes clarify.md
#
# TEMPLATE (fallback):
# .specs/features/NNN-name/clarify.md (or .spec/ if the project already uses it) with Q&A grouped by domain

# --- spec root -------------------------------------------------------------
# `.specs/` is the library-wide standard (ship-ticket and security-audit already
# use it). A project that already has the legacy `.spec/` keeps using it, so
# existing repos are never orphaned by the rename.
SPEC_ROOT=".specs"
if [ -d ".spec" ]; then SPEC_ROOT=".spec"; fi   # safe under `set -e`
# ---------------------------------------------------------------------------

MODE="${1}"
FEATURE_DIR="${2}"

if [ "$MODE" = "--read" ]; then
  # Guard: spec must exist
  if [ ! -f "$FEATURE_DIR/spec.md" ]; then
    echo "❌ spec.md not found in ${FEATURE_DIR}. Run /spec.specify first."
    exit 1
  fi
  echo "=== SPEC ==="
  cat "$FEATURE_DIR/spec.md"
  echo "=== CONSTITUTION ==="
  cat "${SPEC_ROOT}/constitution.md"
  exit 0
fi

if [ "$MODE" = "--write" ]; then
  API_QA="${3}"
  UX_QA="${4}"
  STATE_QA="${5}"
  RTL_QA="${6}"
  PERF_QA="${7}"
  DATE=$(date "+%Y-%m-%d")
  OUT="$FEATURE_DIR/clarify.md"

  # Check if RTL section needed
  RTL_SECTION=""
  RTL=$(grep "^\*\*RTL\*\*" "${SPEC_ROOT}/constitution.md" 2>/dev/null | sed 's/.*| //')
  if [ "$RTL" = "yes" ]; then
    RTL_SECTION="
## Domain: RTL & i18n

${RTL_QA}
"
  fi

  cat > "$OUT" << CLARIFY
# Clarifications: $(basename $FEATURE_DIR)
> Status: $(echo "${API_QA}${UX_QA}${STATE_QA}${PERF_QA}" | grep -q "pending" && echo "Partially Answered" || echo "Resolved")
> Date: ${DATE}

---

## Domain: API & Data

${API_QA}

---

## Domain: UX & Interactions

${UX_QA}

---

## Domain: State & Data Flow

${STATE_QA}
${RTL_SECTION}
---

## Domain: Performance & Constraints

${PERF_QA}

---

## Blocking Issues

- [ ] Review answers above before running /spec.plan
CLARIFY

  echo "✅ Clarify written to ${OUT}"
  exit 0
fi

echo "❌ Usage: clarify.sh --read <dir> | --write <dir> <api> <ux> <state> <rtl> <perf>"
exit 1
