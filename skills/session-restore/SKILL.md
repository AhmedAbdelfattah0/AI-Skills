---
name: session-restore
description: |
  Restore context at the start of a Claude Code session by reading the most
  recent entry in session-log.md — no manual paste needed. Pairs with
  session-logger.

  Trigger when:
  - a new session starts and session-log.md exists
  - the user says "let's continue", "resume", or "pick up where we left off"
  - the user types /restore

  Do NOT: re-read old entries as if actionable, or auto-start deferred work —
  wait for the user.
---

# Session Restore

The read half of session continuity. At session start it loads the latest
`session-log.md` entry so you already know the goal, what's done, and what's
next — without the user re-explaining anything.

## When this fires

Auto-runs at session start if `session-log.md` exists. Also on `/restore`,
"continue", or "resume".

## Step 1 — Read the log (inline, no external script)

```bash
if [ ! -f session-log.md ]; then
  echo "No session-log.md found. Starting fresh."
  exit 0
fi

# Print the last entry (everything after the final --- separator)
awk 'BEGIN{last=""} /^---/{block=$0; next} {block=block"\n"$0} /^---/{last=block} END{print last}' session-log.md
```

Or simply `cat session-log.md` and read the last block.

## Step 2 — Extract from the latest entry only

1. **Goal** — the overall objective.
2. **Completed** — what's done (don't redo it).
3. **Decisions** — choices already made (don't re-propose alternatives).
4. **Deferred** — known pending items.
5. **Next Session Should** — this session's starting point.
6. **Key Files** — files to be aware of.

## Step 3 — Greet with context

```
📂 Session restored from session-log.md

Last session ([date]): [one-line goal]

✅ Completed: [2–3 key items]
⏭️ Ready to: [Next Session Should]

What would you like to work on?
```

## The continuity loop

```
Session starts → session-restore reads session-log.md → greet with context
Work happens
User types /summarize → session-logger appends a new entry
Next session → repeat
```

## Core principles

- **Latest entry only** — older entries are history, not actionable.
- **Never ask the user to re-explain** what's already in the log.
- **Honor prior decisions** — if the log says "chose X over Y", never re-propose Y.
- **Fail silently** if no log exists — don't block the session.
- **Don't auto-start deferred work** — wait for the user to ask.

## What this skill does not do

- Write the log — that's `session-logger` (the pair).
- Restore from git history or PRs — it reads `session-log.md` only.
- Resume automatically into coding — it greets and waits.

## Success criteria

Working when: the session opens with an accurate one-screen recap and a clear
next step, and no already-decided question gets re-litigated.

## Troubleshooting

- **No log:** greet normally and start fresh — absence is not an error.
- **Log is stale / contradicts the code:** trust the code, flag the mismatch,
  and suggest a fresh `/summarize` at the end of this session.
