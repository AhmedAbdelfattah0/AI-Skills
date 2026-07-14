---
name: session-restore
description: >
  Automatically triggered at the start of every new Claude Code session.
  Reads session-log.md from the project root and restores context from
  the most recent session entry. Eliminates the need to manually paste
  session summaries into new conversations. Pairs with session-logger skill.
  Also trigger when user says "let's continue", "resume", "pick up where we left off",
  or types /restore.
---

# Session Restore Skill

## Trigger
Auto-runs at session start if `session-log.md` exists. Also on: `/restore`, "continue", "resume".

---

## STEP 1 — Read session-log.md Directly

Do NOT rely on any external script. Read the file directly:

```bash
# Check if session log exists
if [ ! -f session-log.md ]; then
  echo "No session-log.md found. Starting fresh."
  exit 0
fi

# Print the last entry (everything after the last --- separator)
awk 'BEGIN{last=""} /^---/{block=$0; next} {block=block"\n"$0} /^---/{last=block} END{print last}' session-log.md
```

Or simply:
```bash
cat session-log.md
```

---

## STEP 2 — Extract and Internalize

From the **most recent entry** only, extract:

1. **Goal** — overall project objective
2. **Completed** — what's done (don't redo this work)
3. **Decisions** — choices already made (don't re-propose alternatives)
4. **Deferred** — known pending items
5. **Next Session Should** — specific starting point for this session
6. **Key Files** — files to be aware of

---

## STEP 3 — Greet with Context

Confirm context was loaded with a brief summary:

```
📂 Session restored from session-log.md

Last session ([date]): [one-line goal]

✅ Completed: [2-3 key items]
⏭️ Ready to: [Next Session Should content]

What would you like to work on?
```

---

## Rules

- **Read only the latest entry** — older entries are history, not actionable
- **Never ask the user to re-explain** what's already in the log
- **Honor prior decisions** — if log says "chose X over Y", never re-propose Y
- **Fail silently** if no log exists — don't block the session
- **Don't auto-start deferred work** — wait for user to ask

---

## Full Workflow

```
Session starts → session-restore reads session-log.md → greet with context
Work happens
User types /summarize → session-logger appends new entry
Next session → repeat
```
