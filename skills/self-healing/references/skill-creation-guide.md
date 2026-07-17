# Skill Creation Guide — how skills in this library are built

Follow this when creating a new `SKILL.md` or improving an existing one.
It codifies the conventions the library actually enforces and the patterns
proven across its 17 skills.

## Hard invariants (the validator enforces these — CI fails otherwise)

1. **Folder name == frontmatter `name:`**, exactly.
2. Frontmatter starts with `---` and contains both `name:` and `description:`.
3. Every `.sh` the SKILL.md invokes is either bundled in the repo or generated
   by the skill itself (`mv`/`cp`/`tee`/`>` targeting that basename). A call
   to a script that is neither is the exit-127 trap.

## The description is a router — write it like one

- **Trigger-rich**: literal user phrases ("review these tests", "is this safe
  to merge?"), slash commands (`/tq.guard`), file globs, and "ALWAYS trigger
  when …" situations. The description is what Claude Code matches to decide
  whether to load the skill — dense beats elegant.
- **Negative routing**: end with `DO NOT USE for X (use skill-Y)`. This is how
  17 skills coexist without collisions — every exclusion names the sibling
  that owns the excluded case.
- If the skill should run *reactively* (after work, without being asked), say
  so explicitly in the description — "run after writing X, before presenting,
  without waiting to be asked."

## Progressive disclosure

`SKILL.md` is the always-loaded operating layer — keep it lean. Deep content
(per-stack rules, procedures, bibliographies) lives in `references/*.md`,
loaded only when the task needs them, each with a "Load when" condition.
A `sources.md` per skill holds URLs; other files cite source *names* so the
rules stay readable.

**Never reference a file that does not exist.** A pointer to an unwritten
reference is a false claim (the `docs-accuracy` skill's DOC-01) — inline the
content, write the file, or delete the pointer.

## Cross-skill references

A skill may point at a sibling's reference via `../<skill>/references/<file>`
— this resolves in the repo and in `~/.claude/skills` (skills sit side by
side in both). **Every cross-skill reference carries a one-sentence fallback
summary** in the same row/bullet, so a standalone install degrades gracefully
instead of silently dropping the check.

## Standard sections (include what fits, in this order)

1. Title + one-line job statement ("You are reviewing X before it ships")
2. Why this exists — the named failure modes it counters (cite research where
   it exists; a rule with a source survives pushback)
3. Modes (Guard-pass / Live / Review) for reviewer-type skills
4. "Adapt to the project first" — CLAUDE.md / project conventions win
5. The rules — **stable IDs** (`XX-01…`) so other skills can cite them,
   grouped by severity band with *why the tier matters*
6. Self-check before delivery
7. Reporting format — per `../code-quality/references/review-standard.md`:
   finding = file:line + quote + named fix; reconciled counts; no invented
   scores
8. **What this skill does not do** — jurisdiction boundaries
9. Success criteria — how to tell the skill is working
10. Troubleshooting — false positives, contested findings, degraded modes

## Attribution

Content adapted from an external source names it and its license at the
bottom of the file (e.g. "*Adapted from `amElnagdy/guard-skills` (MIT)*") and
lists primary sources in `references/sources.md`.

## After creating or editing

1. `node scripts/cli.mjs validate` → must print `✅ all skills valid`.
2. Add/update the skill's row in README's catalog; keep the "Skills (N)"
   count == `ls skills | wc -l`.
3. Update CLAUDE.md if the change adds a load-bearing convention.
4. The repo is symlinked into `~/.claude/skills` — edits are live immediately;
   commit is the whole release step.
