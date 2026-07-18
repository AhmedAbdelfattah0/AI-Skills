---
name: self-healing
description: |
  Improve Claude itself by learning from mistakes — recognize recurring failure
  patterns, diagnose the root cause, and update the right skill or guideline so
  the mistake can't recur.

  Trigger when:
  - Claude repeats an error it made before
  - the user corrects the same mistake again ("you always do this", "again?!")
  - a task fails and needs recovery
  - a session ends with lessons worth keeping
  - you're creating or editing any SKILL.md (follow the skill-creation guide)

  Do NOT use for: one-off fixes with no reusable lesson.
---

# Self-Healing

Turn a mistake into a durable fix. When something goes wrong — especially the
*second* time — don't just correct the output; find the root cause and update
the file that would have prevented it.

## When this fires

Claude repeats an error, the user corrects the same thing again, a task fails
and needs recovery, a session ends with lessons worth keeping — or you're
authoring/editing a skill.

| Situation | Where to look |
|---|---|
| Creating or improving a SKILL.md | `references/skill-creation-guide.md` |
| Identifying recurring failure patterns | Steps 1–2 below (same-mistake-twice diagnosis, root-cause over symptom) |
| Deciding what to persist across sessions | Step 4 below (route the lesson to the right skill or CLAUDE.md) |

## Step 1 — Recognize the pattern

```
□ Have I made this same kind of mistake before this session?
□ Did the user correct this same issue previously?
□ Is this a known class of error?
□ Was there a SKILL.md / CLAUDE.md I should have followed but didn't?
```

Any `yes` → this is a self-healing moment. Don't just fix it — learn from it.

## Step 2 — Diagnose the root cause

Name the category before fixing anything:

- **A. Missing context** — I didn't have the information I needed.
- **B. Wrong assumption** — I assumed something untrue.
- **C. Skipped step** — I cut a corner in my process.
- **D. Misread instruction** — I misunderstood the ask.
- **E. Outdated knowledge** — I used stale information.
- **F. Wrong tool** — wrong approach for the problem.

## Step 3 — Fix, then prevent

1. Fix the immediate output.
2. Decide where the prevention belongs:
   - **This project only** → update `CLAUDE.md`.
   - **This kind of task always** → update the relevant `SKILL.md`.
   - **This session only** → note it explicitly before continuing.
3. Make the prevention **concrete** — vague rules don't work:

```
❌ Vague:    "Be more careful with Angular components"
✅ Concrete: "Check shared/components/ for pf-button before creating a new button"
```

## Step 4 — Update the right file

- Project-specific rule → `CLAUDE.md` in the project root.
- Skill improvement → the relevant `SKILL.md` (follow `references/skill-creation-guide.md`).
- Session note → `session-log.md` (via the `session-logger` skill).

## Step 5 — Verify the fix

```
□ Re-run the failed step with the correction applied
□ Confirm the output is now correct
□ State the lesson: "Fixed. Root cause was X. Prevention: Y."
```

## Core principles

- **Never silently fix** — always name what went wrong and why.
- **Never repeat apologies** — one acknowledgment, then move on.
- **Prevention > correction** — updating a skill file beats fixing one output.
- **Be specific** — "I'll be more careful" is not a prevention strategy.

## What this skill does not do

- Fix code quality per se — route those lessons into the code-quality family's rules.
- Persist session state — that's `session-logger`.
- Rewrite skills freely — follow the invariants in `references/skill-creation-guide.md`.

## Success criteria

Working when: a repeated mistake ends with a concrete rule added to the right
file, stated root cause, and a verified fix — so the same error can't recur.

## Troubleshooting

- **Unsure where the rule belongs:** project-specific → CLAUDE.md; universal →
  the skill. When in doubt, the narrower scope first.
- **The lesson is really a detection gap** (a rule keeps slipping through
  review): route it to `nn-guard` for deterministic enforcement.
