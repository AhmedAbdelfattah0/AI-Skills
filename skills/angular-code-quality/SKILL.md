---
name: angular-code-quality
description: |
  Deprecated alias for one release. Load the code-quality skill (stack: angular)
  instead; this alias holds no rules.
---

# angular-code-quality (deprecated alias)

This name is kept for one transitional release only. It holds no rules.

Load the `code-quality` skill: its entry [`SKILL.md`](../code-quality/SKILL.md)
and, for Angular work, [`references/stack-angular.md`](../code-quality/references/stack-angular.md),
which defines every `NG-*` rule. Its LOAD TABLE names the other files a task needs.

The project paths `.claude/angular-code-quality/{profile,deviations}.md` are
unchanged; `code-quality` reads and writes them.

If `code-quality` is not installed beside this alias, `update` installs it. If
`update` reported it as a collision (a foreign or locally edited `code-quality`
directory), resolve that directory first. Until then no rule source is
available: say so, mark the rules check degraded, and do not cite or invent
`NG-*` rule IDs.
