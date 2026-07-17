---
name: self-healing
description: >
  Teaches Claude how to improve itself by learning from mistakes, recognizing
  recurring failure patterns, and updating its own skills and guidelines.
  ALWAYS trigger this skill when: Claude makes an error it has made before,
  the user corrects the same type of mistake repeatedly, a task fails and needs
  recovery, the user says "you always do this wrong" or "again?!", or when
  a session ends and there are lessons worth preserving. Also use when creating
  or updating any SKILL.md file — follow the skill creation guide.
---

# Self-Healing Skill

## What This Skill Does

This skill enables Claude to:
1. Recognize when it's repeating a mistake
2. Diagnose why the mistake happened
3. Update guidelines or skills to prevent recurrence
4. Recover from failed tasks systematically

Read the relevant reference file based on the situation:

| Situation | Read / Focus |
|---|---|
| Creating or improving a SKILL.md | `references/skill-creation-guide.md` |
| Identifying recurring failure patterns | (inline below — same-mistake-twice diagnosis, root-cause over symptom) |
| Managing what Claude remembers across sessions | (inline below — route durable lessons to the right skill or CLAUDE.md) |

---

## STEP 1 — Recognize a Failure Pattern

When something goes wrong, ask:
```
□ Have I made this same type of mistake before in this session?
□ Did the user correct this same issue previously?
□ Is this a known class of error? (see pattern-recognition.md)
□ Was there a SKILL.md or CLAUDE.md that I should have followed but didn't?
```

If yes to any — this is a self-healing moment. Don't just fix it. Learn from it.

---

## STEP 2 — Diagnose the Root Cause

```
Root cause categories:
A. Missing context — I didn't have the information I needed
B. Wrong assumption — I assumed something that wasn't true
C. Skipped step — I cut a corner in my process
D. Misread instruction — I misunderstood what was asked
E. Outdated knowledge — I used stale information
F. Wrong tool — I used the wrong approach for the problem
```

Name the root cause before fixing anything.

---

## STEP 3 — Fix + Prevent

```
1. Fix the immediate problem (correct the output)
2. Identify where the prevention belongs:
   - This project only → update CLAUDE.md
   - This type of task always → update the relevant SKILL.md
   - This session only → note it explicitly before continuing
3. Make the prevention concrete — vague rules don't work
```

**Concrete prevention example:**
```
❌ Vague: "Be more careful with Angular components"
✅ Concrete: "Always check if pf-button exists in shared/components/
             before creating a new button component"
```

---

## STEP 4 — Update the Right File

```bash
# For project-specific rules → CLAUDE.md in project root
# For skill improvements → the relevant SKILL.md
# For session notes → session-log.md (use session-logger skill)
```

When updating a SKILL.md, follow `references/skill-creation-guide.md`.

---

## STEP 5 — Verify the Fix Works

After applying the fix:
```
□ Re-run the failed step with the correction applied
□ Confirm the output is now correct
□ State explicitly what was learned: "Fixed. Root cause was X. Prevention: Y."
```

---

## Rules

- **Never silently fix** — always name what went wrong and why
- **Never repeat apologies** — one acknowledgment, then move forward
- **Prevention > correction** — updating a skill file is more valuable than fixing one output
- **Be specific** — "I'll be more careful" is not a prevention strategy
