---
name: code-quality
description: >
  Universal code quality skill that adapts to ANY technology stack and applies
  Clean Code, SOLID, DRY, KISS, YAGNI, and LLM-specific failure-mode checks in
  any programming language — including stacks with no dedicated reference file
  (Go, Rust, Java, C#, ...). It is the hub of the code-quality family: for
  Angular work it routes to the angular-code-quality skill (NG-* rule IDs), for
  backend work to backend-code-quality (BE-* rule IDs), and it owns the shared
  universal core they all build on. Interviews the user about their stack,
  generates a tailored quality constitution, and saves it to .code-quality.md in
  the project root for all future sessions to reference. ALWAYS trigger when: the user says
  "set up code quality", "what are best practices for X", "create a component",
  "generate a service", "write a function", "review my code", "review this PR",
  "is this safe to merge?", "make this cleaner", "audit this code", "add a
  feature", "refactor this", "fix this bug", or starts working on ANY code task
  in a project that does not have a .code-quality.md.
  Also trigger on: /cq.init, /cq.load, /cq.update, /cq.guard, "configure code quality",
  "I'm using React / Vue / Node / PHP / Laravel / Express / Next.js / Nuxt",
  or any mention of a tech stack without an established quality baseline.
  Additionally run the GUARD pass (MODE D) reactively after writing, editing,
  refactoring, or fixing non-trivial code — before presenting or committing —
  without waiting to be asked. DO NOT USE for factual/conceptual questions,
  CI/tooling config, git workflow, prose writing, or data analysis.
---

# Code Quality Skill

## Overview

This is the **universal front door for code quality** — it works for any stack,
and hands off to the specialist skills for deep, rule-ID-enforced review. It
works in four modes:

| Mode | When | Command |
|---|---|---|
| **Init** | No `.code-quality.md` exists yet | `/cq.init` or start coding |
| **Load** | `.code-quality.md` already exists | `/cq.load` (auto on session start) |
| **Update** | Stack or rules changed | `/cq.update` |
| **Guard** | After code was written/edited, before presenting or committing | `/cq.guard` (also run proactively) |

---

## The code-quality family — how these skills fit

This skill is the **hub**. It owns the universal, language-agnostic core and
routes to specialists for depth. They complete each other; none duplicates
another.

| Skill | Role | What it owns |
|---|---|---|
| **code-quality** (this) | Hub / generalist | The interview + `.code-quality.md` constitution, the reactive **MODE D guard**, and the shared core: `references/universal-principles.md` (Clean Code · SOLID · DRY/KISS/YAGNI), `references/ai-failure-modes.md` (the 15 LLM failure modes + The Floor), `references/review-standard.md` (the findings contract). Works for **any** stack — Go, Rust, Java, C#. |
| **angular-code-quality** | Specialist (frontend) | Enforcement-grade Angular review: the `NG-*` rule IDs, the Design Contract gate, and the evidence-backed Verification Pass. |
| **backend-code-quality** | Specialist (backend) | Same machinery for the backend: `BE-*` rule IDs, security tiers, tenant isolation, webhook safety. |
| **test-quality** | Adjacent guard | Test-code failure modes (`TEST-*`) — mock abuse, test bloat, implementation-detail assertions. |
| **docs-accuracy** | Adjacent guard | Doc/claim verification (`DOC-*`) — every referenced symbol checked against the source. |

**Routing rule:** for an Angular or backend task that needs *enforced* review
(rule IDs, a Verification Pass, a ticket gate), invoke the matching specialist —
this hub's per-stack references (`references/angular.md`, `references/nodejs.md`)
are **constitution-level summaries**, not the enforcement source of truth. The
two always-load core files above apply in every skill, so the specialists build
on the same foundation this hub defines.

---

## MODE A — INIT: First-Time Setup

Triggered when `.code-quality.md` does NOT exist in the project root.

### STEP A1 — Check for Existing Constitution

```bash
if [ -f ".code-quality.md" ]; then
  echo "FOUND"
  cat .code-quality.md
else
  echo "NOT_FOUND"
fi
```

If `FOUND` → jump to **MODE B (Load)**.
If `NOT_FOUND` → proceed with the interview below.

---

### STEP A2 — Stack Interview

Ask the user these questions **in a single message** (do not chain questions):

```
I'll generate a tailored code quality constitution for your project.
Quick setup — answer what applies:

1. **Project type**: Web app / API / Mobile / CLI / Library / Full-stack?
2. **Frontend** (if any): React / Vue / Angular / Next.js / Nuxt / Svelte / Vanilla / None?
3. **Backend** (if any): Node.js+Express / Node.js+Fastify / PHP+Laravel / PHP vanilla / Python+FastAPI / Python+Django / None?
4. **Language**: TypeScript / JavaScript / PHP / Python / other?
5. **Styling** (if frontend): Tailwind / CSS Modules / SCSS / Styled Components / other?
6. **State management** (if frontend): Signals / Zustand / Pinia / Redux / Context / None?
7. **Database** (if any): PostgreSQL / MySQL / MongoDB / Supabase / Firebase / None?
8. **Key constraints** (optional): e.g. SSR, RTL support, multi-tenant, real-time, mobile-first
```

✋ STOP — Wait for the user's answers before proceeding to STEP A3.

---

### STEP A3 — Load the Right Reference Files

Based on the user's answers, read the relevant reference files:

| Stack | Read |
|---|---|
| **Any stack — always** | `references/universal-principles.md` (Clean Code, SOLID, DRY/KISS/YAGNI) |
| **Any stack — always** | `references/ai-failure-modes.md` (the model's own failure modes) |
| **Angular** | **Invoke the `angular-code-quality` skill** for enforced review (`NG-*`, Design Contract, Verification Pass). `references/angular.md` is the constitution-level summary only. |
| **Node.js / any backend** | **Invoke the `backend-code-quality` skill** for enforced review (`BE-*`, security tiers). `references/nodejs.md` is the constitution-level summary only. |
| React / Next.js | `references/react.md` |
| Vue / Nuxt | `references/vue.md` |
| PHP (any) | `references/php.md` |
| Python (any) | `references/python.md` |
| Tailwind CSS | `references/tailwind.md` |
| TypeScript | `references/typescript.md` |

For a full-stack project, read all relevant files (e.g. `react.md` + `nodejs.md` + `typescript.md`).
The two **always** files are read regardless of stack — `universal-principles.md` is the
language-agnostic engineering layer (it's what makes this skill work for Go, Rust, Java, C#,
or any stack with no per-stack file), and `ai-failure-modes.md` guards against the model's
own systematic failure modes, not the stack's.

For **Angular and backend**, the per-stack summaries below exist so a standalone
`code-quality` install can still write a constitution — but when the specialist
skill is present, it is the source of truth for those rules. Do not let the
summary contradict the specialist; if they differ, the specialist wins.

---

### STEP A4 — Generate the Constitution

Using the reference files and user answers, write `.code-quality.md` to the project root.
Use a temp file to preserve multiline formatting, then move it into place:

```bash
TMPFILE=$(mktemp)
cat > "$TMPFILE" << 'CONSTITUTION_EOF'
[GENERATED CONTENT goes here — Claude fills this in based on the interview + reference files]
CONSTITUTION_EOF
mv "$TMPFILE" .code-quality.md
echo "✅ .code-quality.md created"
```

**Constitution shape — Claude fills each section with stack-specific content:**

```markdown
# Code Quality Constitution
<!-- Generated by code-quality skill. Edit freely — run /cq.update to regenerate. -->

## Stack
- **Project type**: [e.g. Full-stack web app]
- **Frontend**: [e.g. React 19 + TypeScript]
- **Backend**: [e.g. Node.js + Express]
- **Styling**: [e.g. Tailwind CSS v4]
- **State**: [e.g. Zustand]
- **Database**: [e.g. PostgreSQL via Supabase]
- **Constraints**: [e.g. SSR, RTL support]

---

## Architecture Pattern
[e.g. Feature-based folder structure with separation of concerns]

### Folder Structure
```
[Tailored directory tree for their stack]
```

### File Placement Rules
- [Rule 1: where components go]
- [Rule 2: where types/interfaces go]
- [Rule 3: where API/service calls go]

---

## Code Patterns

### Always Do
[Stack-specific best practices with code examples]

### Never Do
[Stack-specific anti-patterns with code examples]

---

## Naming Conventions
[Tailored to language/framework — e.g. PascalCase components, camelCase functions]

---

## Component / Module Rules
[Frontend: file structure, props typing, state rules]
[Backend: route structure, middleware, controller/service split]

---

## State Management Rules
[Tailored to their state choice — signals, zustand, pinia, etc.]

---

## API / Data Layer Rules
[Where HTTP calls live, how errors are handled, typing responses]

---

## Universal Principles (stack-agnostic — always in force)
- Names reveal intent — no unqualified `data`/`result`/`temp`/`helper`/`handle_*`
- Functions ≤20 lines target, one thing; ≤4 params (5th → config object); no boolean flags
- Comments explain WHY, never WHAT
- SOLID: one actor per module · extend via new code, not type-branches · no override
  that refuses the parent contract · small interfaces · abstractions live with the client
- DRY = one representation of each piece of KNOWLEDGE (not "no similar-looking code");
  Rule of 3 before extracting; wrong abstraction is worse than duplication — re-inline it
- Complexity ceilings: cyclomatic ≤10, nesting ≤5
- YAGNI: no interface/factory/flag/option without a caller today — "who calls this today?"

## AI Failure-Mode Guardrails (stack-agnostic — always in force)
- No catch-all error swallowing; catch only what you can recover from
- No guards for cases the type system / caller contract excludes; DO validate at trust boundaries
- No abstraction (interface/factory/base class) without ≥2 concrete users today
- No hardcoded "success" returns or fixture data in production paths
- Verify every import/API against the installed version — never call what "should" exist
- Search the repo for an existing helper before writing a new one
- No speculative flags/options/env vars without a present-day caller
- Comments explain WHY, never WHAT
- Refactors preserve observable behavior — a bug found mid-refactor is flagged, never bundled

## The Floor — never removed while simplifying
- Trust-boundary validation/sanitization · error handling that prevents data loss ·
  security measures (authz, escaping, parameterized queries, secrets) ·
  explicitly requested behavior

## Self-Check Before Declaring Done
[Tailored checklist — 8-12 items specific to their stack]
```

---

### STEP A5 — Confirm and Activate

After writing, output:
```
✅ Code quality constitution saved to .code-quality.md

Stack: [one-line summary]
Pattern: [architecture pattern name]

Rules are now active for this session. Type /cq.update any time to revise.
What would you like to build?
```

Then immediately apply the constitution rules to whatever coding task follows.

---

## MODE B — LOAD: Apply Existing Constitution

Triggered automatically when `.code-quality.md` exists, or via `/cq.load`.

### STEP B1 — Read the Constitution

```bash
if [ -f ".code-quality.md" ]; then
  cat .code-quality.md
else
  echo "No .code-quality.md found. Run /cq.init to create one."
fi
```

### STEP B2 — Internalize and Confirm

Read the full file. Then output a single-line confirmation only — do NOT dump the file at the user:

```
📋 Code quality rules loaded ([stack summary] · [pattern name]).
```

### STEP B3 — Apply to All Code Tasks

Every piece of code written in this session MUST follow the loaded constitution.
Treat `.code-quality.md` as the project's CLAUDE.md equivalent for code standards.

---

## MODE C — UPDATE: Revise the Constitution

Triggered via `/cq.update` or when the user says "we switched to X" / "add a rule for Y".

### STEP C1 — Read Current Constitution

```bash
cat .code-quality.md
```

### STEP C2 — Identify What Changed

Ask:
```
What changed? (e.g. "Added Tailwind", "Switched from Zustand to Signals", "Add no-any rule")
```

✋ STOP — Wait for the user's answer.

### STEP C3 — Patch or Regenerate

- **Small change** (1-3 rules): patch in place with str_replace on `.code-quality.md`
- **Stack change**: re-run full interview (STEP A2) and regenerate the entire file

After updating:
```
✅ .code-quality.md updated — [what changed]
```

---

## MODE D — GUARD: Reactive Pass on the Diff

Triggered via `/cq.guard`, **and proactively**: run it yourself after writing,
editing, refactoring, or fixing non-trivial code — before presenting the result
or committing — without waiting to be asked. This mode works even in a project
with **no** `.code-quality.md` (the failure modes are stack-agnostic); when a
constitution exists, check against it too.

### STEP D1 — Establish the diff

Check what changed (`git diff`, or the files just edited this session). The
guard runs on the change, not the whole repo.

### STEP D2 — Walk the guardrails

Read `references/ai-failure-modes.md` and `references/universal-principles.md`,
then walk against the diff: the 15 modes + The Floor + refactoring discipline,
and the classic layer — naming/function-size/comments, the SOLID smells table,
DRY's knowledge-not-text test, the complexity ceilings, and the ranked YAGNI
over-engineering list. With a constitution loaded, also walk its Always/Never
lists and Self-Check. **If the diff contains test files**, hand the test
portion to the `test-quality` skill's guard pass (TEST-01..12) — test code has
its own failure modes this walk doesn't cover. **If the diff touches docs
surfaces** (`*.md`, docstrings), hand those to the `docs-accuracy` skill's
guard pass (DOC-01..10) — claims get verified against the source, not assumed.

### STEP D3 — Fix, then report

Fix violations directly (guard pass, not review — but never widen scope beyond
the diff). Anything you can't fix without a user decision gets flagged, not
silently shipped. Then surface the pass so the user sees it ran:

```
<file>[:<line>] — <what changed>
...
code-quality guard: <N> fixed, <M> flagged — or "clean"
```

Report only changes actually made. **Never estimate a quality score or
percentage** — no baseline exists, so the number would be invented.

If the user asked for a *review* (not a fix), report findings in this shape
instead of editing: each finding = `file:line` + the quoted code + a concrete
fix, grouped Critical / Important / Nit, ending with per-section coverage
(`clean` only after actually walking the section — a blank section is an
unbacked claim, not a pass). The full findings contract — scope discipline,
contested-review protocol, severity vocabulary map — is the library standard
in `references/review-standard.md`; read it for any formal review.

---

## Rules for Claude

- **Load before code**: Always read `.code-quality.md` before writing any code in the project
- **Constitution wins**: If `.code-quality.md` contradicts this SKILL.md, the constitution wins
- **No silent drift**: If asked to violate a rule, flag it explicitly and ask for confirmation.
  A granted exception is documented in a code comment naming the rule, the reason, and a
  **revisit trigger** (the condition under which to reconsider) — an exception with no exit
  is just deferred debt, and shows up as a finding on the next guard pass
- **Guard before presenting**: MODE D runs after every non-trivial code change — it is part
  of finishing the task, not an extra the user must request
- **Keep it lean**: The constitution should be actionable checklists, not a textbook
- **Inline bash only**: All bash runs inline — never reference external `.sh` files that may not exist
- **Temp file pattern**: Use `mktemp` + `mv` for writing constitution to avoid multiline arg issues
