---
name: docs-accuracy
description: |
  Documentation accuracy gate — verifies that READMEs, API references,
  docstrings, PHPDoc/JSDoc, changelogs, and tutorials tell the truth about the
  code. Core method: documentation is a set of claims, and every claim is
  checkable against the source.

  Trigger when:
  - docs were just written or edited (by you or another agent), before publishing
  - a code change touched documented behavior (rename, signature change, new
    default, removed flag)
  - the user says "review the docs", "is this documentation accurate", "update
    the docs", "write a README", "document this API", "add a docstring/changelog"
  - the user types /da.guard

  Do NOT use for: production code review (code-quality family), test review
  (test-quality), marketing copy or blog posts, prose-style editing of
  non-technical writing, or doc-site theming.
---

# Docs Accuracy

Verify every documentation claim against the source before it ships.

Documentation is a set of claims about a codebase, and every claim is
checkable. Your job is to check them — **by reading the source, not
recalling it**.

Why this exists: AI agents document from memory of how APIs *usually* look,
not from the code in front of them. Published research: half of AI answers to
programming questions contain incorrect information, and models produce valid
invocations for infrequent APIs barely a third of the time — yet the prose
sounds authoritative either way. Readers cannot tell verified docs from
hallucinated docs. You can, because you have the source.

## Modes

- **Guard-pass** (default, run without being asked): after docs were
  generated/edited, verify every claim against the source, fix, self-check.
- **Live**: invoked before writing — read the actual implementation first,
  then document what it does.
- **Review**: user asks to review/audit/fact-check docs — walk
  `references/review-checklist.md`, produce findings with file:line evidence,
  don't rewrite unless asked.

## Adapt to the project first

1. CLAUDE.md / AGENTS.md / docs style guide win on conflict.
2. Identify the doc surfaces that move together: README, reference docs,
   docstrings, changelog, examples, config samples (DOC-06).
3. Note the version policy: supported versions, where features are tagged.

## The rules (DOC-01 … DOC-10)

### Accuracy — must fix

- **DOC-01 — Every referenced symbol must exist.** Every function, class,
  hook, CLI flag, endpoint, config key, env var, and file path is verified
  against the source — grep the *definition*, not usages. Procedure:
  `references/verification.md`. An unverifiable reference does not ship.
- **DOC-02 — Every code sample must work.** Imports resolve, APIs exist with
  the documented signatures, and the sample runs on a clean machine — no local
  paths, no real credentials, no implicit prior state. Rules:
  `references/code-samples.md`.
- **DOC-03 — Document actual behavior, not intended behavior.** Read the
  implementation before describing it. Where code and comments/specs disagree,
  **the code is the truth** — and flag the disagreement to the user instead of
  silently picking a side.
- **DOC-04 — No unverifiable claims.** Performance numbers, compatibility
  matrices, and "production-ready" assertions need a repo source (benchmark
  script, CI matrix, changelog) or they come out. *"Fast" is marketing;
  "O(n log n), benchmarked in bench/sort.md" is documentation.*

### Versioning and drift — should fix

- **DOC-05 — Versions are explicit.** Features state their introducing
  version; prerequisites are pinned or ranged, never "latest"; deprecated
  items say so with the replacement.
- **DOC-06 — A code change owes a docs change.** Rename, signature change,
  new default, removed flag → update every doc surface that mentions it in the
  same change. **Grep the docs for the old symbol before finishing.**

### Substance — should fix

- **DOC-07 — No filler, no slop.** Delete docstrings that paraphrase the
  signature, sections that restate their heading, marketing adjectives, and
  intro padding. A docstring earns its place only by adding contracts the
  signature can't express (units, ranges, errors, side effects, ordering).
  Details: `references/docstrings.md`.
- **DOC-08 — Link upstream, don't paraphrase it.** Paraphrased upstream docs
  drift the moment upstream changes. Document only your project's relationship
  to the external thing.
- **DOC-09 — Examples cover the failure path.** Happy-path-only tutorials
  document half the API. Show the error and what the caller does — using error
  types the code actually raises (verify per DOC-01).

### Structure — worth noting

- **DOC-10 — Navigation tells the truth.** TOC matches headings, links and
  anchors resolve, no TODO stubs or "coming soon" in published docs —
  unwritten sections are removed, not promised.

## When you cannot verify

1. **Say so explicitly** rather than guessing.
2. **Downgrade the claim** to what you can verify.
3. **Never decorate an unverified claim with confident language.** "Should",
   "appears to", or a direct question to the user beats a fluent hallucination.

## Self-check before delivery

1. Every symbol/flag/endpoint/key/path mentioned — verified against source
   *this session*, not from memory?
2. Every sample runs on a clean machine? Imports + signatures checked?
3. Any number or superlative without a repo-verifiable source?
4. If code changed: grepped all doc surfaces for the old names?
5. Any docstring restating the signature? Section restating its heading?
6. All internal links/anchors resolve?

## Reporting format (review mode)

```
**DOC-NN violation** in `docs/path.md:<line or section>`
- Claim: <what the docs say>
- Reality: <what the code/CLI/schema actually has, with file:line>
- Fix: <one sentence>
```

Lead with DOC-01..04 (false claims), then drift, then substance. End with the
count: `docs-accuracy: N claims checked, M false, K unverifiable`. A review
that checks 40 claims and finds 2 false is a *good* result — say so; if a doc
is clean, say so in one line. Accuracy deserves credit. Full findings
contract: `../code-quality/references/review-standard.md` (if absent —
standalone install — the rules in this file suffice).

## What this skill does not do

- Review the code itself — the code-quality family's jurisdiction. This skill
  reviews what the docs *claim about* the code.
- Generate documentation strategy or information architecture — it guards
  accuracy and substance, not scope decisions.
- Enforce prose style — tone belongs to the project; truth belongs here.

## Success criteria

Working when: generated READMEs stop referencing functions that don't exist,
`@param` tags match real signatures, samples run on a clean machine,
"blazingly fast" leaves the building, and every code rename ships with its
docs grep.

## Troubleshooting

- Claim source unreachable (private dep, external service): apply the
  cannot-verify protocol — downgrade, don't decorate.
- The doc is aspirational by design (roadmap, RFC): out of scope — this skill
  guards docs that describe *current* behavior; label the doc as such.
- Too many findings to fix now: fix must-fix (DOC-01..04) before shipping;
  file the rest.

---

*Adapted from `amElnagdy/guard-skills` (docs-guard, MIT). Sources:
`references/sources.md`.*
