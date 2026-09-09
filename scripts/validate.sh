#!/usr/bin/env bash
# Bash entry point for the skill validator.
#
# This is a thin wrapper, deliberately. The validator used to be implemented
# twice — once here and once in cli.mjs — and the two drifted, which is exactly
# the failure the checks themselves exist to catch. There is now one
# implementation; this just calls it, so the two entry points cannot disagree.
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "validate.sh: needs Node, which is not on PATH." >&2
  echo "  Install Node, or run the validator directly: node scripts/cli.mjs validate" >&2
  exit 127
fi

exec node "$(dirname "$0")/cli.mjs" validate "$@"
