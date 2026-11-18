---
name: backend-code-quality
description: |
  Deprecated alias for one release. Load the code-quality skill (stack: backend)
  instead; this alias holds no rules.
---

# backend-code-quality (deprecated alias)

This name is kept for one transitional release only. It holds no rules.

Load the `code-quality` skill: its entry [`SKILL.md`](../code-quality/SKILL.md)
and, for backend work in any language, the whole of
[`references/stack-backend.md`](../code-quality/references/stack-backend.md),
which defines every `BE-*` rule. Its LOAD TABLE names the other files a task
needs (webhook, tenancy, RLS).

The project paths `.claude/backend-code-quality/{profile,deviations}.md` are
unchanged; `code-quality` reads and writes them.

`install` and `update` put `code-quality` beside this alias unless a foreign or
locally edited `code-quality` directory is in the way. **Check the file, not the
install log:** if `../code-quality/references/stack-backend.md` does not exist, no rule
source is available (an older or foreign `code-quality` has none). Say so, mark
the rules check degraded, and do not cite or invent `BE-*` rule IDs.
