#!/usr/bin/env bash
# Validate every skill in skills/. Exits non-zero if any check fails, so it can
# gate CI. Checks the failure modes that actually break skill installs:
#
#   1. Folder name must equal the frontmatter `name:` (mismatch installs wrong).
#   2. Frontmatter must exist and contain both `name:` and `description:`.
#   3. Every external `.sh` a SKILL.md invokes must actually EXIST in the repo.
#      A bundled script (e.g. spec-driven/scripts/plan.sh) is fine. A call to a
#      script that no longer exists is the exit-127 trap — that's what we catch.

set -uo pipefail

REPO_SKILLS="$(cd "$(dirname "$0")/../skills" && pwd)"
fail=0

# Pre-index every .sh basename that exists anywhere in the repo.
declare -A HAVE_SCRIPT=()
while IFS= read -r f; do
  HAVE_SCRIPT["$(basename "$f")"]=1
done < <(find "$REPO_SKILLS" -type f -name '*.sh')

echo "Validating skills in $REPO_SKILLS"
echo ""

for dir in "$REPO_SKILLS"/*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  md="$dir/SKILL.md"
  err=0

  # 1. SKILL.md exists
  if [ ! -f "$md" ]; then
    echo "❌ $name: no SKILL.md"
    fail=1
    continue
  fi

  # Extract YAML frontmatter (between the first two '---' lines)
  fm="$(awk 'NR==1 && $0!="---"{exit} /^---[[:space:]]*$/{c++; next} c==1{print} c==2{exit}' "$md")"
  if [ -z "$fm" ]; then
    echo "❌ $name: missing or empty frontmatter (must start with '---')"
    fail=1
    continue
  fi

  # 2a. name present + matches folder
  fm_name="$(printf '%s\n' "$fm" | grep -E '^name:' | head -n1 | sed -E 's/^name:[[:space:]]*//; s/[[:space:]]*$//')"
  if [ -z "$fm_name" ]; then
    echo "❌ $name: frontmatter has no 'name:'"; err=1; fail=1
  elif [ "$fm_name" != "$name" ]; then
    echo "❌ $name: folder name != frontmatter name ('$fm_name'). Must match exactly."; err=1; fail=1
  fi

  # 2b. description present
  if ! printf '%s\n' "$fm" | grep -qE '^description:'; then
    echo "❌ $name: frontmatter has no 'description:'"; err=1; fail=1
  fi

  # 3. Every invoked .sh must exist in the repo. Pull basenames of scripts that
  #    are called via bash/sh/source/./, ignoring '...' placeholders in prose.
  while IFS= read -r script; do
    [ -z "$script" ] && continue
    base="$(basename "$script")"
    # OK if the script is bundled anywhere in the repo.
    [ -n "${HAVE_SCRIPT[$base]:-}" ] && continue
    # OK if this SKILL.md creates the script itself (hook installers do this):
    # a mv/cp/tee/install/redirect whose target is that basename.
    esc="$(printf '%s' "$base" | sed 's/[.[\*^$]/\\&/g')"
    if grep -qE "(mv|cp|tee|install|>)[^|]*${esc}" "$md"; then
      continue
    fi
    echo "❌ $name: calls '$base' but it is neither bundled nor created by the skill (exit-127 risk — inline, bundle, or generate it)."
    err=1; fail=1
  done < <(grep -oE '(bash|sh|source|\.)[[:space:]]+[^[:space:]`"'"'"']*\.sh' "$md" \
             | grep -v '\.\.\.' \
             | sed -E 's/^(bash|sh|source|\.)[[:space:]]+//')

  [ "$err" -eq 0 ] && echo "✅ $name"
done

echo ""
if [ "$fail" -ne 0 ]; then
  echo "❌ validation failed"
  exit 1
fi
echo "✅ all skills valid"
