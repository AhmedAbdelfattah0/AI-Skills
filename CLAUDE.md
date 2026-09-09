# CLAUDE.md

**Read [AGENTS.md](AGENTS.md) in full before acting. It is the canonical
instruction file for this repository.**

There is nothing else here. `AGENTS.md` carries what this repo is, the commands,
the invariants the validator enforces, the skill anatomy, the cross-skill
conventions, and the architecture notes for every skill in the library.

This file exists only because Claude Code looks for `CLAUDE.md` by name. It is a
pointer, deliberately: `SKILL.md` is an open standard consumed by several agents,
so the repository's own instructions are agent-neutral and live in one place.
Two hand-maintained copies preceded this arrangement and had already drifted
apart by 76 lines, including a mechanical find-and-replace that told Codex the
skills live in `~/.Codex/skills`, a path that does not exist.

**Do not add content here.** If you are about to write repository guidance into
this file, it belongs in `AGENTS.md`.
