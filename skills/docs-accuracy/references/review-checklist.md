# docs-accuracy — Review-Mode Checklist

Structured walk for review mode ("review/audit/fact-check these docs").
Findings first, file:line always. Adapted from `amElnagdy/guard-skills` (MIT).

## The five passes

1. **Claim verification** (DOC-01, 03, 04) — extract every claim per
   `verification.md`; verify each against its source of truth; every false
   claim is a finding with the contradicting definition site.
2. **Code samples** (DOC-02, 09) — walk the shippable checklist in
   `code-samples.md` on every fenced block; run them when the runtime allows.
3. **Drift scan** (DOC-05, 06) — for each documented symbol, does the current
   code still match? Any recently renamed/removed symbol still mentioned?
   Versions pinned?
4. **Substance** (DOC-07, 08) — paraphrase-test every docstring/section;
   flag marketing adjectives and upstream paraphrase.
5. **Navigation** (DOC-10) — TOC vs headings, resolve every internal link and
   anchor, hunt "coming soon" stubs.

## Output

Use the SKILL.md reporting format (Claim / Reality with file:line / Fix),
grouped by doc file, must-fix first. Close with reconciled counts:

```
docs-accuracy: N claims checked, M false, K unverifiable
```

Rules of the report:
- A blank pass is an unbacked claim — walk it or say why not.
- A review that checks 40 claims and finds 2 false is a good result; say so.
- Never invent an "accuracy percentage" — count claims, don't score vibes.
- Clean docs get one line of credit, not manufactured findings.
