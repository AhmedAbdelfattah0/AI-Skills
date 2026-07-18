---
name: security-audit
description: |
  Reasoning-based security audit for Angular and web projects. Wave-based
  scanning minimizes token burn — high-risk files first, deeper only if needed —
  and findings become spec-tracked tasks that survive across sessions in
  .specs/security-audit/. Works in Claude Code (reads disk) or claude.ai chat
  (paste mode).

  Trigger when:
  - the user says "audit my code", "security check", "check for vulnerabilities",
    "is my code secure", "security review", or "run a security scan"
  - the user types /sec.audit, /sec.specify, /sec.plan, /sec.tasks,
    /sec.implement, or /sec.fix
  - the user shares code involving auth, payments, API calls, guards,
    interceptors, CORS config, environment files, HTTP headers, file uploads, or
    reactive forms — even without an explicit security request
---

# Security Audit

Token-frugal, reasoning-based security audit — scans highest-risk files first in
waves, calibrates severity to real exploitability, and turns findings into
spec-tracked tasks that survive across sessions.

## Commands

| Command | What it does | Prerequisite |
|---|---|---|
| `/sec.audit` | Wave-based scan → audit-report.md | None |
| `/sec.specify` | Findings → tracked spec.md | audit-report.md |
| `/sec.plan` | Fix architecture → plan.md | spec.md |
| `/sec.tasks` | Severity-ordered tasks → tasks.md | plan.md |
| `/sec.implement` | Fix tasks one by one, mark done | tasks.md |
| `/sec.fix <N>` | Jump to task N (min token load) | tasks.md |

Artifacts: `.specs/security-audit/` — separate from feature specs.
**All bash below runs inline — no external scripts required.**

---

## STEP 0 — Detect Environment

Run this first on every `/sec.*` command:

```bash
ls src/ 2>/dev/null && echo "CLAUDE_CODE" || echo "CHAT_MODE"
```

- **CLAUDE_CODE** → read files from disk using inline find/cat commands below
- **CHAT_MODE** → ask user to paste files in waves (never all at once)

---

## /sec.audit

### Wave Strategy

Read highest-risk files first. Stop early if CRITICAL findings found — deeper waves
may be invalidated by the fixes. 80% of real vulnerabilities live in Wave 1.

| Wave | Files | Token cost | Load references |
|---|---|---|---|
| 1 | auth, guards, interceptors, env, checkout | ~10 files | auth-secrets + api-web-security |
| 2 | services, form components, routing, api layer | ~20 files | input-validation + angular-security |
| 3 | all remaining .ts (excl. .spec.ts) | remainder | any not yet loaded |

> Source waves scan `.ts` only. They **cannot** see headers, exposed ports, HTTP methods,
> or server banners — run the **Deployment & Runtime Surface** pass (below) before writing
> the report, or those whole classes of finding are missed.

---

### Wave 1 — Claude Code (inline)

```bash
mkdir -p .specs/security-audit

echo "=== WAVE 1 FILES ===" && \
find src -type f -name "environment*.ts" 2>/dev/null && \
find . -maxdepth 3 -name "staticwebapp.config.json" 2>/dev/null | grep -v node_modules && \
find src -type f -name "*.ts" | grep -v "\.spec\.ts" | \
  grep -iE "(auth|login|session|token|jwt|msal|sso|guard|interceptor|checkout|payment|cart|order|basket)" | \
  sort
```

Read each file listed. Audit against the auth/secrets + API/web checks in this file (token storage, hashing, JWT expiry, CORS, headers, rate limits). Accumulate findings.

Also run these application-layer checks on the auth surface (absence of a control is itself a finding):

```bash
# Brute-force protection present on auth routes?
grep -rInE "throttle|rateLimit|RateLimiter|lockout|attempts|backoff" src | grep -iE "auth|login" \
  || echo "FINDING: no rate-limit / lockout signal on auth routes"
# Passwords hashed with a real KDF (not plaintext / bare fast hash)?
grep -rInE "bcrypt|argon2|scrypt" src | grep -iE "auth|user|password" \
  || echo "FINDING: no salted-KDF password hashing signal near credential writes"
```

**Decision after Wave 1:**
- CRITICAL found → write report immediately, tell user to run `/sec.specify`
- Clean or LOW/MEDIUM only → run Wave 2

---

### Wave 2 — Claude Code (inline)

```bash
echo "=== WAVE 2 FILES ===" && \
find src -type f -name "*.service.ts" | grep -v "\.spec\.ts" | \
  grep -viE "(auth|login|session|token|jwt|msal|checkout|payment|cart|order)" | sort && \
find src -type f -name "*.component.ts" | grep -v "\.spec\.ts" | \
  xargs grep -l "FormBuilder\|FormGroup\|FileReader\|HttpClient" 2>/dev/null | sort && \
find src -type f \( -name "*.routes.ts" -o -name "*routing*.ts" \) | grep -v "\.spec\.ts" | sort && \
find src -type f -name "*.ts" | grep -v "\.spec\.ts" | \
  grep -iE "(api|http|endpoint)" | \
  grep -viE "(auth|interceptor|checkout|payment)" | sort
```

Audit against the input-validation + Angular checks in this file (sanitization, XSS sinks, template injection, form validation). Add to findings.

Also grep for XSS sinks across the frontend (any hit on non-constant/remote data is a finding):

```bash
grep -rIn "bypassSecurityTrust" src         # bypassing Angular sanitization
grep -rIn "\[innerHTML\]\|innerHTML *=" src  # untrusted HTML binding
```

---

### Wave 3 — Claude Code (inline, only if needed)

```bash
echo "=== WAVE 3 FILES ===" && \
find src -type f -name "*.ts" | grep -v "\.spec\.ts" | grep -v "\.module\.ts" | \
  grep -viE "(auth|login|session|token|jwt|msal|sso|guard|interceptor|checkout|payment|cart|order|basket|service|routes|routing|api|http|endpoint)" | \
  sort
```

Load any references not yet loaded. Audit remaining files.

---

### Wave 1 — Chat Mode (Claude.ai)

Send this message to the user:

> "To audit efficiently without burning tokens, let's go wave by wave.
>
> **Wave 1 — paste these files** (highest security risk):
> - `src/environments/environment*.ts`
> - Any file named: `auth.service.ts`, `*.guard.ts`, `*.interceptor.ts`
> - Any file named: `checkout*.ts`, `payment*.ts`, `cart*.ts`
> - `staticwebapp.config.json` (if exists)
>
> Paste what you have — skip files that don't exist."

Audit pasted content against the auth/secrets + API/web checks in this file.

**If CRITICAL found** → write report, tell user: *"Wave 1 found critical issues. Run `/sec.specify` before continuing."*
**If clean** → request Wave 2.

### Wave 2 — Chat Mode

> "Wave 1 done. Now paste **Wave 2** files:
> - `*.service.ts` files not already shared
> - `*.component.ts` files that use forms or file upload
> - `app-routing.module.ts` or `app.routes.ts`
> - Any `api*.ts` or `http*.ts` files"

Audit against the input-validation + Angular checks in this file.

### Wave 3 — Chat Mode (only if needed)

> "**Wave 3** — paste any remaining `.ts` files not yet shared, excluding `*.spec.ts` and `*.module.ts`."

---

### Deployment & Runtime Surface (mandatory — source scan cannot see this)

Headers, HTTP methods, server banners, exposed ports, and transport live in config and
infra, not `.ts` — so the waves above will never surface them. Run this pass before writing
the report.

- **CLAUDE_CODE** → grep the config that carries these controls:

```bash
echo "=== RUNTIME SURFACE ===" && \
grep -rInE "Content-Security-Policy|Strict-Transport-Security|X-Frame-Options|X-Content-Type-Options|Referrer-Policy|Permissions-Policy|helmet" \
  . --include=*.ts --include=*.js --include=web.config --include=*.conf 2>/dev/null | grep -v node_modules || echo "FINDING: no security-header config found"
grep -rInE "removeServerHeader|X-Powered-By|server_tokens|TRACE|OPTIONS" \
  . --include=web.config --include=*.conf --include=*.ts 2>/dev/null | grep -v node_modules
grep -rInE "EXPOSE|ports:|0\.0\.0\.0" . --include=Dockerfile --include=docker-compose*.yml 2>/dev/null | grep -v node_modules
```

- **CHAT_MODE** → ask the user to paste the reverse-proxy / `web.config` / helmet setup and,
  if available, a response-header dump or `nmap`/port-scan output.

Confirm each — an unchecked item is a finding:

```
□ Security headers present: CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy
□ HTTP methods restricted (TRACE disabled; OPTIONS only if CORS preflight is served)
□ Server/framework banners suppressed (no Server version, no X-Powered-By)
□ No data services internet-exposed (DB 3306/5432, cache, broker, SSH 22) — highest priority
□ HTTPS enforced with HTTP→HTTPS redirect + HSTS
□ Framework/runtime dependencies checked against EOL, not just "latest"
```

---

### Write Report (inline — both modes)

After waves complete, write the report directly:

```bash
mkdir -p .specs/security-audit
DATE=$(date "+%Y-%m-%d")
cat > .specs/security-audit/audit-report.md << 'EOF'
# 🔐 Security Audit Report
> **Project**: PROJECT_NAME
> **Date**: DATE_VALUE
> **Risk Score**: RISK_SCORE
> **Waves Run**: WAVES_RUN
> **Status**: Findings Pending Triage

## 🔴 CRITICAL
CRITICAL_FINDINGS

## 🟠 HIGH
HIGH_FINDINGS

## 🟡 MEDIUM
MEDIUM_FINDINGS

## 🟢 LOW / INFO
LOW_FINDINGS

## ✅ Passed Checks
PASSED_CHECKS

## 🛠️ Priority Fix List
PRIORITY_LIST

## 📋 Next Step
Run `/sec.specify` to convert findings into tracked tasks.
EOF
echo "✅ Written to .specs/security-audit/audit-report.md"
```

Replace placeholders with actual findings before running.

---

## /sec.specify

Guard check then write spec inline:

```bash
# Guard
[ -f ".specs/security-audit/audit-report.md" ] || { echo "❌ Run /sec.audit first."; exit 1; }

DATE=$(date "+%Y-%m-%d")
cat > .specs/security-audit/spec.md << 'EOF'
# Security Audit Spec
> **Scope**: SCOPE
> **Date**: DATE_VALUE
> **Status**: Awaiting Plan

## Summary
| Severity | Count |
|---|---|
| 🔴 CRITICAL | CRITICAL_COUNT |
| 🟠 HIGH | HIGH_COUNT |
| 🟡 MEDIUM | MEDIUM_COUNT |
| 🟢 LOW | LOW_COUNT |

## Vulnerabilities (Requirements)
VULNERABILITY_LIST

## Out of Scope
OUT_OF_SCOPE

## Open Questions
OPEN_QUESTIONS

## Acceptance Criteria
- [ ] All CRITICAL findings resolved before deploy
- [ ] All HIGH findings resolved or risk-accepted with justification
- [ ] MEDIUM findings resolved or tracked in backlog
- [ ] No regressions introduced by fixes
- [ ] Fixes verified with /sec.audit re-scan

## Next Step
Run `/sec.plan` to produce fix architecture per file.
EOF
echo "✅ Written to .specs/security-audit/spec.md"
```

---

## /sec.plan

```bash
# Guard
[ -f ".specs/security-audit/spec.md" ] || { echo "❌ Run /sec.specify first."; exit 1; }

DATE=$(date "+%Y-%m-%d")
cat > .specs/security-audit/plan.md << 'EOF'
# Security Fix Plan
> **Date**: DATE_VALUE
> **Status**: Awaiting Tasks

## Affected Files
AFFECTED_FILES

## Fix Patterns
FIX_PATTERNS

## Config / Infrastructure Changes
REFERENCE_CHANGES

## Risks & Notes
RISKS

## Next Step
Run `/sec.tasks` to generate ordered fix tasks.
EOF
echo "✅ Written to .specs/security-audit/plan.md"
```

---

## /sec.tasks

```bash
# Guard
[ -f ".specs/security-audit/plan.md" ] || { echo "❌ Run /sec.plan first."; exit 1; }

DATE=$(date "+%Y-%m-%d")
cat > .specs/security-audit/tasks.md << 'EOF'
# Security Fix Tasks
> **Date**: DATE_VALUE
> **Status**: Not Started

## Legend
- `[P]` — Parallel safe (no file conflict)
- `[DONE]` — Fixed and verified
- `[SKIP]` — Risk-accepted with justification

## Tasks
TASKS_CONTENT

## Progress Tracker
| Task | Severity | File | Status |
|---|---|---|---|
PROGRESS_ROWS

## Session Notes
> Add cross-session notes here

## Next Step
Run `/sec.implement` or `/sec.fix <task_id>` to start fixing.
EOF
echo "✅ Written to .specs/security-audit/tasks.md"
```

Replace `TASKS_CONTENT` and `PROGRESS_ROWS` with actual task list (CRITICAL first).

---

## /sec.implement

```bash
# Guard check — show pending tasks
[ -f ".specs/security-audit/tasks.md" ] || { echo "❌ Run /sec.tasks first."; exit 1; }
echo "=== PENDING TASKS ==="
grep "⬜ Not started" .specs/security-audit/tasks.md
echo "=== TASK DETAILS ==="
grep "^### Task\|^\*\*File:\*\*\|^\*\*Severity:\*\*\|^\*\*Reference:\*\*" .specs/security-audit/tasks.md
```

For each task:
1. Read its `**Reference:**` field → load only that one reference file
2. Apply the fix to the file
3. Mark done inline:

```bash
TASK_ID="001"
TASKS_FILE=".specs/security-audit/tasks.md"

# Mark header done
sed -i "s/^### Task ${TASK_ID} /### Task ${TASK_ID} [DONE] /" "$TASKS_FILE"

# Tick checkboxes for this task
awk -v id="Task ${TASK_ID}" '
  /^### Task/ { in_task = ($0 ~ id) }
  in_task && /^- \[ \]/ { sub(/\[ \]/, "[x]") }
  { print }
' "$TASKS_FILE" > "$TASKS_FILE.tmp" && mv "$TASKS_FILE.tmp" "$TASKS_FILE"

# Update progress tracker
sed -i "s/| ${TASK_ID} .*⬜ Not started/| ${TASK_ID} | ✅ Done /" "$TASKS_FILE"

echo "✅ Task ${TASK_ID} marked DONE"
REMAINING=$(grep -c "⬜ Not started" "$TASKS_FILE" || true)
echo "Remaining: ${REMAINING}"
```

To risk-accept a finding:
```bash
TASK_ID="003"
REASON="Accepted: internal admin tool, not user-facing"
TASKS_FILE=".specs/security-audit/tasks.md"
sed -i "s/^### Task ${TASK_ID} /### Task ${TASK_ID} [SKIP] /" "$TASKS_FILE"
sed -i "s/| ${TASK_ID} .*⬜ Not started/| ${TASK_ID} | ⏭️ Skipped: ${REASON} /" "$TASKS_FILE"
echo "⏭️ Task ${TASK_ID} skipped — ${REASON}"
```

**When all tasks done** — write session log inline:
```bash
DATE=$(date "+%Y-%m-%d")
ENTRY="## ${DATE} — security-audit complete
- Done: ALL_DONE_TASKS
- Files changed: FILES_CHANGED
- Decisions: DECISIONS
- Next: NEXT_STEPS"
echo "$ENTRY" >> .claude/session-log.md
echo "✅ Session logged"
```

---

## /sec.fix \<N\>

Shortcut — read task N from tasks.md, load only its reference, apply fix, mark done using the `--done` inline block above. Minimum token cost for a single targeted fix.

---

## Report Format Reference

```
## 🔐 Security Audit Report
**Project**: name  **Date**: today  **Risk Score**: CRITICAL|HIGH|MEDIUM|LOW
**Waves Run**: 1 of 3 | 2 of 3 | All 3

### 🔴 CRITICAL
| # | File:Line | Issue | Fix |
|---|-----------|-------|-----|

### 🟠 HIGH / 🟡 MEDIUM / 🟢 LOW / ✅ Passed

### 🛠️ Priority Fix List
1. [CRITICAL] description — exploitable without auth
```

---

> **Severity vocabulary note:** this skill's CRITICAL/HIGH/MEDIUM/LOW scale is
> calibrated to *exploitability* and deliberately differs from the library's
> code-review bands (Critical/Important/Nit). The mapping between scales lives
> in `../code-quality/references/review-standard.md` — when reporting alongside
> a code review, map both to "blocks merge / should fix / note".

## Severity Guide

| Level | Meaning |
|---|---|
| CRITICAL | Exploitable now, no auth required, breach risk |
| HIGH | Exploitable with minimal effort, auth bypass or data leak |
| MEDIUM | Requires specific conditions, degrades security posture |
| LOW | Best-practice violation, low direct exploit risk |

---

## Core Principles

- **Never trust the client** — client-side validation is UX only
- **Fail closed** — deny by default on auth/guards; never fail open
- **Waves over full dump** — high-risk files first, stop when findings warrant it
- **Load references lazily** — only the ref matching the current wave or task
- **No external scripts** — all bash runs inline; nothing depends on `.claude/skills/` paths
- **Calibrate every severity against real exploitability** — don't inherit a scanner's or
  report's label. In particular:
  - Internet-exposed data services (DB/cache/SSH) outrank most "High" app findings — a
    reachable database is a direct breach.
  - A private/RFC1918 IP disclosed in DNS is informational, not High — it isn't
    internet-routable.
  - "Outdated dependency" is only a finding after an EOL/advisory check — "not latest" ≠
    vulnerable.
  - A web app accepting over-long input is input-validation / mild DoS, not a "buffer
    overflow."
  - Credentials over HTTPS are not "clear text" — the fix is HSTS + server-side hashing, not
    client-side crypto.
  - "Latent XSS if future code changes" is LOW/INFO unless a live sink (`innerHTML` /
    `bypassSecurityTrust`) actually renders it now.

---

## What this skill does not do

- Enforce day-to-day secure-coding patterns while writing — the `security`
  skill owns that; this skill audits what was written.
- Code-quality review — the code-quality family owns NG-*/BE-* and diff-scoped
  reviews; this skill deliberately scans whole surfaces (audits are the
  documented exception to diff-scope).
- Fix findings uninvoked — findings become spec-tracked tasks
  (`/sec.specify` → `/sec.implement`); fixes run when asked.

## Success criteria

Working when: every audit ends with a severity-calibrated report (no inherited
scanner labels), findings carry File:Line + fix, the runtime/deployment pass
ran (or each unchecked item is itself a finding), and CRITICALs block deploy
until resolved and re-scanned.

## Troubleshooting

- **Token budget tight on a big repo:** that's the point of waves — stop after
  Wave 1 if it finds CRITICALs; deeper waves may be invalidated by the fixes.
- **Tempted to inherit a scanner's "High":** re-calibrate to real exploitability
  (see the Severity Guide) — an internet-exposed DB outranks a latent XSS.
- **Chat mode (no disk):** request files in waves, never all at once; skip files
  the user doesn't have rather than blocking.
