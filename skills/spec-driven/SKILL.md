---
name: spec-driven
description: >
  Enforces a structured spec-driven development workflow for Angular + MVVM + Signals projects
  via six slash commands: /spec.constitution, /spec.specify, /spec.clarify, /spec.plan,
  /spec.tasks, /spec.implement. Each command checks that the prior artifact exists before
  proceeding. Scripts handle all file creation — Claude only decides content values.
  ALWAYS trigger when the user types any /spec.* command, mentions "spec-driven",
  asks to "write a spec", "create a feature spec", "start a new feature with a spec",
  "ratify the constitution", or wants to plan a feature before coding it. Also trigger
  when the user says "let's spec this out", "I want to plan this feature first",
  or "what tasks do I need for X feature".
---

# Spec-Driven Development Skill

Scripts live in `.claude/skills/spec-driven/scripts/`. Claude extracts values, scripts write files.

## STEP 0 — Verify Scripts Are Installed

Before running ANY command, check scripts exist:

```bash
ls .claude/skills/spec-driven/scripts/specify.sh 2>/dev/null || echo "NOT_INSTALLED"
```

If `NOT_INSTALLED` — run setup from the global install location:
```bash
bash ~/.claude/skills/spec-driven/scripts/setup.sh
```

This copies scripts from `~/.claude/skills/` into the project's `.claude/skills/` once per project.

If that also fails, tell the user to run manually:
```bash
mkdir -p .claude/skills/spec-driven/scripts
cp ~/.claude/skills/spec-driven/scripts/*.sh .claude/skills/spec-driven/scripts/
chmod +x .claude/skills/spec-driven/scripts/*.sh
```

---

## Commands

| Command | Script | Prerequisite |
|---|---|---|
| `/spec.constitution` | `constitution.sh` | None |
| `/spec.specify` | `specify.sh` | constitution.md |
| `/spec.clarify` | `clarify.sh` | spec.md |
| `/spec.design` | `design.sh` | clarify.md (optional but recommended) |
| `/spec.plan` | `plan.sh` | clarify.md + design.md (if exists) |
| `/spec.tasks` | `tasks.sh` | plan.md |
| `/spec.implement` | `implement.sh` (guard only) | tasks.md |

**`/spec.design` is optional but strongly recommended when working from Stitch or Figma.**
Without it, Claude guesses design values during `/spec.tasks` — causing style bugs.

---

## /spec.constitution

**Extract from user:**
- `PROJECT_NAME` — e.g. "PipeForge"
- `PROJECT_TYPE` — `ikea` or `personal`
- `UI_FRAMEWORK` — `skapa` or `tailwind`
- `SELECTOR_PREFIX` — e.g. `pf-`, `lg-`
- `MARKETS` — e.g. "KSA + Bahrain (AR/EN)" or "Global (EN only)"
- `RTL` — `yes` or `no`

Ask the user for these values if not already provided, then run:

```bash
bash .claude/skills/spec-driven/scripts/constitution.sh \
  "<PROJECT_NAME>" "<PROJECT_TYPE>" "<UI_FRAMEWORK>" \
  "<SELECTOR_PREFIX>" "<MARKETS>" "<RTL>"
```

✋ **STOP. Do not proceed to /spec.specify automatically.**
Confirm to user: "✅ Constitution written to .spec/constitution.md — run /spec.specify when ready."

---

## /spec.specify

**Extract from user:**
- `FEATURE_NAME` — short kebab-case name (e.g. `auth-login`)
- `OVERVIEW` — one paragraph, product language only
- `STORIES` — 2–5 user stories (As a / I want / So that + Given/When/Then criteria)
- `REQUIREMENTS` — functional requirements, no tech details
- `OUT_OF_SCOPE` — explicit exclusions
- `OPEN_QUESTIONS` — seed questions for /spec.clarify

**Step 1 — Write to temp file:**
```bash
cat > .claude/skills/spec-driven/scripts/.specify.tmp << 'CONTENT'
OVERVIEW: <one paragraph overview>
---STORIES---
### Story 1 — Title
**As a** user, **I want** goal, **So that** benefit.
- [ ] Given ... when ... then ...

---REQUIREMENTS---
### FR-01: Requirement Name
Description. Priority: Must Have.

---OUT_OF_SCOPE---
- Item not included

---OPEN_QUESTIONS---
- [ ] Question to carry into /spec.clarify
CONTENT
```

**Step 2 — Run script:**
```bash
bash .claude/skills/spec-driven/scripts/specify.sh "<FEATURE_NAME>"
```

✋ **STOP. Do not proceed to /spec.clarify automatically.**
Confirm to user: "✅ Spec written — run /spec.clarify when ready."

**Read spec.md first:**
```bash
bash .claude/skills/spec-driven/scripts/clarify.sh --read "<FEATURE_DIR>"
```

Generate questions grouped by: API, UX, State, RTL (if RTL=yes in constitution), Performance.
Present questions to user. Collect answers. Then write:

```bash
bash .claude/skills/spec-driven/scripts/clarify.sh --write "<FEATURE_DIR>" \
  "<API_QA>" "<UX_QA>" "<STATE_QA>" "<RTL_QA>" "<PERF_QA>"
```

✋ **STOP. Do not proceed to /spec.plan automatically.**
Confirm to user: "✅ Clarifications written — run /spec.design (if using Stitch/Figma) or /spec.plan when ready."

---

## /spec.design

**Purpose:** Extract and lock down exact design values from Stitch or Figma BEFORE planning.
Without this step, Claude guesses colors, spacing, and typography during tasks — causing style bugs.

**Prerequisite:** `clarify.md` must exist. Stitch MCP must be connected.

**Action:**
1. Read `constitution.md` for project type and selector prefix
2. Connect to Stitch MCP → read the frame ID(s) provided by user
3. Extract ALL values exhaustively — never approximate or interpolate
4. Write `design.md` via script

**Extract per component:**
- Typography: font-family, weight, size, line-height, color, transform per element
- Colors: exact hex for backgrounds, borders, text, icons, hover/active states
- Spacing: exact px for padding, margin, gap per layout zone
- Layout: grid/flex config, column widths, sticky values, breakpoints
- Sizing: fixed px for thumbnails, buttons, panels, images
- Components: which shared components to reuse and which props/variants

**Step 1 — Write to temp file:**
```bash
cat > .claude/skills/spec-driven/scripts/.design.tmp << 'CONTENT'
---COMPONENTS---
List every UI component and which shared component it maps to

---TYPOGRAPHY---
element | font-family | weight | size | color | transform

---COLORS---
name | hex | used for

---SPACING---
zone | padding | margin | gap (exact px)

---LAYOUT---
grid/flex config | column widths | breakpoints | sticky values

---SIZING---
element | width | height | constraints

---STATES---
element | hover | active | disabled | empty

---MOBILE---
breakpoint | layout changes | mobile-specific values
CONTENT
```

**Step 2 — Run script:**
```bash
bash .claude/skills/spec-driven/scripts/design.sh "<FEATURE_DIR>"
```

✋ **STOP. Do not proceed to /spec.plan automatically.**
Confirm to user: "✅ Design spec written to design.md — run /spec.plan when ready."

---

## /spec.plan

**During plan and tasks:** Always read `design.md` first if it exists — reference exact values, never approximate.

**Activate session-restore first (inline — session-restore has no external script):**
```bash
[ -f session-log.md ] \
  && awk 'BEGIN{last=""} /^---/{block=$0; next} {block=block"\n"$0} /^---/{last=block} END{print last}' session-log.md \
  || echo "No session-log.md yet."
```

Read constitution + spec + clarify. Then:

**Step 1 — Write to temp file:**
```bash
cat > .claude/skills/spec-driven/scripts/.plan.tmp << 'CONTENT'
---STACK---
| Concern | Decision | Rationale |
|---|---|---|
| State | Angular Signals | ... |

---FOLDER_STRUCTURE---
src/app/features/[name]/
├── components/
├── models/
├── pages/
└── services/

---SIGNALS---
| Signal | Type | Initial | Purpose |
|---|---|---|---|

---REPOSITORY---
Methods: get(), create(), update(), delete()

---MODELS---
interface definitions

---ROUTING---
{ path: '...', loadComponent: ... }

---UI_NOTES---
SKAPA packages OR Tailwind tokens (based on PROJECT_TYPE)

---SSR_GUARDS---
Browser APIs + guard pattern, or "None"

---RTL_NOTES---
RTL handling or "Not applicable"

---RISKS---
| Risk | Likelihood | Mitigation |
CONTENT
```

**Step 2 — Run script:**
```bash
bash .claude/skills/spec-driven/scripts/plan.sh "<FEATURE_DIR>"
```

✋ **STOP. Do not proceed to /spec.tasks automatically.**
Confirm to user: "✅ Plan written — run /spec.tasks when ready."

Read plan.md + spec.md + constitution.md. Then:

**Step 1 — Write tasks to temp file** (preserves formatting, no arg-passing):
```bash
cat > .claude/skills/spec-driven/scripts/.tasks.tmp << 'TASKS'
### Task T01 — [Title]
**File:** src/app/features/[name]/models/[name].model.ts
**Depends on:** none
**Parallel:** no
**Acceptance Criteria:**
- [ ] Criterion one
- [ ] Criterion two

### Task T02 [P] — [Title]
**File:** src/app/features/[name]/services/[name]-state.service.ts
**Depends on:** T01
**Parallel:** yes
**Acceptance Criteria:**
- [ ] Criterion one
- [ ] Criterion two
TASKS
```

Each task on its own block, one blank line between tasks.
Mark parallel-safe tasks with `[P]` in the header.
Detect `VIOLATIONS` — Tailwind on IKEA, SKAPA on Personal, HttpClient in component, signal in component.

**Step 2 — Run script:**
```bash
bash .claude/skills/spec-driven/scripts/tasks.sh "<FEATURE_DIR>" "<VIOLATIONS>"
```

✋ **STOP. Do not proceed to /spec.implement automatically.**
Confirm to user: "✅ Tasks written — review tasks.md then run /spec.implement when ready."

**Guard check + activate angular-code-quality:**
```bash
bash .claude/skills/spec-driven/scripts/implement.sh --check "<FEATURE_DIR>"
```

For each task in tasks.md:
1. Read acceptance criteria
2. Write the file — apply angular-code-quality rules (MVVM, Signals, OnPush, inject(), no `any`)
3. Mark done:
```bash
bash .claude/skills/spec-driven/scripts/implement.sh --done "<FEATURE_DIR>" "<TASK_ID>"
```

**On all tasks complete — activate session-logger (inline — session-logger has no external script):**
```bash
[ ! -f session-log.md ] && printf "# Session Log\n\nAuto-generated by session-logger. Do not edit manually.\n\n" > session-log.md
cat >> session-log.md << 'EOF'
---
## Session: [YYYY-MM-DD HH:mm]

**Goal:** [feature just implemented]

**Completed:**
- [files created/modified]

**Decisions:**
- [key decisions + reasons]

**Deferred:**
- [blockers / what was left]

**Next Session Should:**
- [specific starting point]

**Key Files:**
- `path/to/file.ts` — [what changed]

EOF
echo "✅ Session entry appended to session-log.md"
```

---

## Determining Active Feature

When feature not specified by user:
```bash
bash .claude/skills/spec-driven/scripts/list-features.sh
```
- 1 feature → use it automatically
- Multiple → ask user which one
- 0 → prompt to run `/spec.specify` first

---

## Fallback Rule

If any script is not found at `.claude/skills/spec-driven/scripts/`:
Write the artifact manually using the format defined in that script's header comments.
Never silently skip — always produce the artifact one way or another.
