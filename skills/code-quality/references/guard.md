# Guard: MODE D

Loaded from `code-quality` (`../SKILL.md`) for `/cq.guard` and after every
non-trivial code change.

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

Read `ai-failure-modes.md` and `universal-principles.md`,
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
in `review-standard.md`; read it for any formal review.

---

## Troubleshooting

- **Guard feels too broad:** it runs on the diff, not the repo (STEP D1). If
  it's flagging untouched files, re-scope to the change.
