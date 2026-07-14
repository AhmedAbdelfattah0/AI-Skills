---
name: nn-guard
description: >
  Installs and manages deterministic enforcement of the code-quality skill's [NN]
  rules, outside the model's context: a Claude Code PostToolUse hook that checks
  every file edit the moment it lands, and a CI job that fails the PR on the same
  rules. Trigger on: /guard.install, /guard.check, /guard.status, /guard.ci,
  "install the guard", "set up hooks", "enforce NN rules", "add the CI security
  check", or when the code-quality deviation ledger shows [NN] violations reaching
  review (a detection gap). Pairs with code-quality (source of the rules) and
  self-healing (which routes detection gaps here).
---

# NN-Guard — Deterministic `[NN]` Enforcement

The `code-quality` skill governs at the prompt level: it works because the model reads
the rules and complies. This skill adds the layer that holds **when the model doesn't** —
context erosion at hour three, a subagent that never loaded the rule set, a session
where the skill didn't trigger. Hooks and CI are deterministic: they run every time,
read nothing from context, and cannot be argued with.

**Three layers, same rule IDs:**

| Layer | Mechanism | When it fires | Strength |
|---|---|---|---|
| 1 | `code-quality` skill | While Claude writes | Advisory — model-dependent |
| 2 | PostToolUse hook | The instant a file is written | Deterministic — feedback loop |
| 3 | CI job | On every PR | Deterministic — hard gate |

A finding at layer 2 is fed back to Claude as a blocking error with the rule ID — Claude
must fix it before proceeding. A finding at layer 3 fails the pipeline. Same script,
same IDs, one source of truth.

**Severity policy — a guard that cries wolf gets disabled:**
- **BLOCK** (hook exit 2 + CI fail): rules whose grep signature is near-unambiguous —
  `BE-SEC-10` (TLS disable), `NG-SEC-02` (sanitizer bypass), `BE-WHK-01` (`==` on a
  signature), `BE-SEC-05` (SQL built from request input).
- **WARN** (hook: visible, non-blocking · CI: fails only in STRICT): heuristic
  signatures with legitimate exceptions — `NG-CORE-01` (`any`), `NG-CORE-03`/`BE-Q-02`
  (`console.log` — normal mid-development, forbidden at PR), `BE-SEC-07` (empty catch),
  `NG-UI-02` (hex colors — token files legitimately contain them), hardcoded-secret
  patterns (test fixtures collide).

So: edit-time blocks only the unambiguous; **CI in STRICT mode blocks both** — which is
exactly the "no console.log *committed*" semantics the rules always meant.

The full ID→layer→severity mapping with rationale: `references/enforcement-map.md`.

---

## /guard.install — install hook + config

Everything below is inline; the installer materializes real files and then **verifies
each one exists** before touching `settings.json` — a hook entry pointing at a missing
script is the phantom-file bug (pattern P1) with worse consequences.

### 1. Write the guard script

```bash
mkdir -p .claude/hooks .claude/nn-guard
TMPFILE=$(mktemp)
cat > "$TMPFILE" <<'GUARD'
#!/bin/sh
# nn-guard.sh — deterministic [NN] rule checks. One source of truth for hook + CI.
# Usage:  nn-guard.sh <file>...        (explicit files)
#         echo '<hook-json>' | nn-guard.sh    (Claude Code PostToolUse)
# Env:    STRICT=1  → WARN findings also fail (CI mode)
#         NN_GUARD_EXCLUDE unset → read from .claude/nn-guard/exclude (one glob/line)
# Exit:   0 clean/warn-only · 2 blocking findings (stderr carries rule IDs)

EXCLUDE_FILE=".claude/nn-guard/exclude"
BLOCKED=0; WARNED=0

excluded() {
  [ -f "$EXCLUDE_FILE" ] || return 1
  while IFS= read -r pat; do
    [ -z "$pat" ] && continue
    case "$pat" in \#*) continue;; esac
    case "$1" in $pat) return 0;; esac
  done < "$EXCLUDE_FILE"
  return 1
}

hit()  { printf 'BLOCK %s %s: %s\n' "$2" "$1" "$3" >&2; BLOCKED=1; }
warn() {
  if [ "${STRICT:-0}" = "1" ]; then printf 'BLOCK(strict) %s %s: %s\n' "$2" "$1" "$3" >&2; BLOCKED=1
  else printf 'WARN  %s %s: %s\n' "$2" "$1" "$3" >&2; WARNED=1; fi
}

check_file() {
  f="$1"
  [ -f "$f" ] || return 0
  excluded "$f" && return 0
  case "$f" in
    *.ts|*.js|*.mjs|*.tsx|*.jsx|*.py|*.go|*.php)
      grep -nE 'REJECT_UNAUTHORIZED.{0,4}(0|false)|InsecureSkipVerify[[:space:]]*:?=?[[:space:]]*true|verify[[:space:]]*=[[:space:]]*False' "$f" >/dev/null 2>&1 \
        && hit "$f" BE-SEC-10 "TLS verification disabled"
      grep -nE '(==|!=)=?[[:space:]]*(signature|sig\b)|(signature|sig)[[:space:]]*(==|!=)=?' "$f" >/dev/null 2>&1 \
        && hit "$f" BE-WHK-01 "signature compared with ==/!= (timing leak) — use constant-time verify"
      grep -nE 'bypassSecurityTrust' "$f" >/dev/null 2>&1 \
        && hit "$f" NG-SEC-02 "DomSanitizer bypass — sanitize, don't bypass"
      grep -nE '`[^`]*\b(SELECT|INSERT|UPDATE|DELETE)\b[^`]*\$\{|["'"'"'][^"'"'"']*\b(SELECT|INSERT|UPDATE|DELETE)\b[^"'"'"']*["'"'"'][[:space:]]*\+[[:space:]]*(req\.|request\.|params|body|query)|f["'"'"'][^"'"'"']*\b(SELECT|INSERT|UPDATE|DELETE)\b[^"'"'"']*\{' "$f" >/dev/null 2>&1 \
        && hit "$f" BE-SEC-05 "SQL built from interpolated/concatenated input — parameterize"
      grep -nE 'catch[[:space:]]*\([^)]*\)[[:space:]]*\{[[:space:]]*\}' "$f" >/dev/null 2>&1 \
        && warn "$f" BE-SEC-07 "empty catch — handle, log, or re-throw"
      grep -nE '(:[[:space:]]*any\b|<any>|as any\b)' "$f" >/dev/null 2>&1 \
        && warn "$f" NG-CORE-01 "untyped 'any' escape hatch"
      grep -nE 'console\.log\(' "$f" >/dev/null 2>&1 \
        && warn "$f" NG-CORE-03 "console.log (fine mid-dev; must not reach the PR)"
      grep -nE '(api_?key|secret|password|token)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9+/_\-]{16,}["'"'"']' "$f" >/dev/null 2>&1 \
        && warn "$f" BE-RT-03 "possible hardcoded secret — secrets come from config"
      ;;
    *.scss|*.css)
      grep -nE '#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(' "$f" >/dev/null 2>&1 \
        && warn "$f" NG-UI-02 "hardcoded color — tokens only (token files: add to .claude/nn-guard/exclude)"
      ;;
    *.html)
      grep -nE '[[:space:]]on(click|load|error|input|change|submit)[[:space:]]*=' "$f" >/dev/null 2>&1 \
        && warn "$f" NG-SEC-04 "inline event handler — breaks strict CSP"
      ;;
  esac
}

if [ $# -gt 0 ]; then
  for f in "$@"; do check_file "$f"; done
else
  # Claude Code hook mode: JSON on stdin; extract tool_input.file_path without jq
  IN=$(cat)
  FP=$(printf '%s' "$IN" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
  [ -n "$FP" ] && check_file "$FP"
fi

[ "$BLOCKED" = "1" ] && { echo "nn-guard: fix the BLOCK findings above (rule IDs are from the code-quality skill; a genuine exception goes through GATE 2, not past this hook)." >&2; exit 2; }
[ "$WARNED" = "1" ] && echo "nn-guard: warnings above — must be clean before PR (CI runs STRICT=1)." >&2
exit 0
GUARD
mv "$TMPFILE" .claude/hooks/nn-guard.sh
chmod +x .claude/hooks/nn-guard.sh
[ -x .claude/hooks/nn-guard.sh ] && echo "✅ .claude/hooks/nn-guard.sh installed" || echo "❌ install failed — STOP"
```

### 2. Seed the exclude list (prevents the false positives that get guards disabled)

```bash
TMPFILE=$(mktemp)
cat > "$TMPFILE" <<'EXCL'
# nn-guard exclude — one shell glob per line. Comments allowed.
# Token/theme files legitimately contain raw color values (NG-UI-02):
*tokens*.scss
*theme*.scss
src/styles.scss
# Generated output:
dist/*
coverage/*
EXCL
mv "$TMPFILE" .claude/nn-guard/exclude
echo "✅ exclude list seeded — add your token file paths now if they differ"
```

> ✋ **STOP** — ask the user where their token/theme files live and update the exclude
> list before wiring the hook. A guard that flags the token file on every edit is a
> guard that gets turned off within a day.

### 3. Wire the hook into settings.json (merge, never overwrite)

```bash
python3 - <<'PY'
import json, os
p = ".claude/settings.json"
cfg = {}
if os.path.exists(p):
    with open(p) as f: cfg = json.load(f)
entry = {"matcher": "Edit|Write|MultiEdit",
         "hooks": [{"type": "command", "command": "sh .claude/hooks/nn-guard.sh"}]}
hooks = cfg.setdefault("hooks", {}).setdefault("PostToolUse", [])
if not any("nn-guard" in h.get("command","") for e in hooks for h in e.get("hooks",[])):
    hooks.append(entry)
with open(p, "w") as f: json.dump(cfg, f, indent=2)
print("✅ PostToolUse hook wired in .claude/settings.json")
PY
```

### 4. Verify — the check that can fail

A guard that has never blocked anything is unproven. Feed it a known-bad file; it
**must** exit 2:

```bash
TMPBAD=$(mktemp /tmp/nn-guard-selftest-XXXX.ts)
echo 'process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";' > "$TMPBAD"
sh .claude/hooks/nn-guard.sh "$TMPBAD"; RC=$?
rm "$TMPBAD"
[ "$RC" = "2" ] && echo "✅ self-test passed — guard blocks known-bad input" \
                || echo "❌ self-test FAILED (exit $RC) — guard is not enforcing. STOP."
```

Commit `.claude/hooks/`, `.claude/nn-guard/`, and `.claude/settings.json` so the whole
team (and every future session) gets the same enforcement.

---

## /guard.ci — install the CI gate

Same script, STRICT mode, changed-files-only. Pick the platform:

### GitHub Actions

```bash
mkdir -p .github/workflows
TMPFILE=$(mktemp)
cat > "$TMPFILE" <<'CI'
name: nn-guard
on:
  pull_request:
jobs:
  nn-guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - name: Run [NN] rule guard on changed files (STRICT)
        run: |
          git diff --name-only --diff-filter=ACMR origin/${{ github.base_ref }}...HEAD \
            | tr '\n' '\0' | xargs -0 -r sh .claude/hooks/nn-guard.sh
        env:
          STRICT: "1"
CI
mv "$TMPFILE" .github/workflows/nn-guard.yml
echo "✅ .github/workflows/nn-guard.yml installed"
```

### Azure Pipelines (add as a step to the existing pipeline yaml)

```bash
TMPFILE=$(mktemp)
cat > "$TMPFILE" <<'ADO'
# Add this step to the PR validation stage:
- script: |
    git fetch origin $(System.PullRequest.TargetBranch) --depth=1
    git diff --name-only --diff-filter=ACMR origin/$(System.PullRequest.TargetBranch)...HEAD \
      | tr '\n' '\0' | xargs -0 -r sh .claude/hooks/nn-guard.sh
  displayName: "nn-guard: [NN] rules (STRICT)"
  env:
    STRICT: "1"
ADO
mv "$TMPFILE" .claude/nn-guard/azure-pipelines-step.yml
echo "✅ ADO step written to .claude/nn-guard/azure-pipelines-step.yml — paste into your pipeline"
```

---

## /guard.check — run manually, any time

```bash
# Whole repo (advisory):
find src -type f \( -name '*.ts' -o -name '*.scss' -o -name '*.html' \) -print0 \
  | xargs -0 -r sh .claude/hooks/nn-guard.sh
# Strict (what CI will see):
STRICT=1 find src -type f \( -name '*.ts' -o -name '*.scss' -o -name '*.html' \) -print0 \
  | xargs -0 -r sh .claude/hooks/nn-guard.sh
```

## /guard.status — what's installed and proven

```bash
echo "hook script:  $( [ -x .claude/hooks/nn-guard.sh ] && echo present || echo MISSING )"
echo "exclude list: $( [ -f .claude/nn-guard/exclude ] && echo present || echo MISSING )"
grep -q "nn-guard" .claude/settings.json 2>/dev/null && echo "settings.json: wired" || echo "settings.json: NOT WIRED"
[ -f .github/workflows/nn-guard.yml ] && echo "CI (GitHub):  installed" || echo "CI (GitHub):  not installed"
[ -f .claude/nn-guard/azure-pipelines-step.yml ] && echo "CI (ADO):     step file present" || true
```

---

## Rules for Claude

- **The hook outranks the conversation.** If the hook blocks an edit, the fix is to
  satisfy the rule or run the `code-quality` GATE 2 deviation flow — never to edit the
  guard script, the exclude list, or `settings.json` to make the finding disappear.
  Weakening the guard is an `[NN]`-tier change: propose, never apply (self-healing valve).
- **Exclude list changes are deviations.** Adding a glob suppresses findings forever —
  each addition gets a ledger entry with the rule ID it suppresses and why.
- **Keep the three layers in sync.** A new `[NN]` rule with a greppable signature gets
  added here in the same change (self-healing "detection gap" → this file). A rule with
  no mechanical signature stays skill-only — that's honest; don't fake a check.
- **Never edit the installed script in place** — change it here (the skill is the
  source), re-run `/guard.install`, re-run the self-test.
- The self-test is mandatory after every install or change. A check that cannot fail
  checks nothing.
