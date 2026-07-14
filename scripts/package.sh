#!/usr/bin/env bash
# Build a .skill archive for one or all skills into dist/.
# .skill files are plain zip archives with the skill folder at the root; a raw
# .md renamed to .skill is NOT valid, which is why we zip programmatically.
#
#   ./scripts/package.sh                 # package every skill
#   ./scripts/package.sh session-logger  # package just one

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_SKILLS="$REPO_ROOT/skills"
DIST="$REPO_ROOT/dist"
mkdir -p "$DIST"

package_one() {
  local name="$1"
  local dir="$REPO_SKILLS/$name"
  [ -f "$dir/SKILL.md" ] || { echo "⚠️  skip '$name' — no SKILL.md"; return; }
  python3 - "$REPO_SKILLS" "$name" "$DIST" <<'PY'
import sys, zipfile, os
skills_root, name, dist = sys.argv[1], sys.argv[2], sys.argv[3]
src = os.path.join(skills_root, name)
out = os.path.join(dist, f"{name}.skill")
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for root, _, files in os.walk(src):
        for f in files:
            full = os.path.join(root, f)
            # store with the skill folder as the archive root
            arc = os.path.join(name, os.path.relpath(full, src))
            z.write(full, arc)
print(f"📦 {out}")
PY
}

if [ "$#" -ge 1 ]; then
  package_one "$1"
else
  for dir in "$REPO_SKILLS"/*/; do
    package_one "$(basename "$dir")"
  done
fi

echo "✅ archives written to $DIST"
