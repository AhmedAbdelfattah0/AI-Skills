---
name: researcher
description: |
  Research topics thoroughly and validate that information is accurate before
  using it in code, architecture, or recommendations — never skip it when
  accuracy matters.

  Trigger when:
  - investigating a library or comparing frameworks
  - verifying an API exists or checking whether a package is maintained
  - looking up current best practices
  - validating a technical approach
  - before ANY claim that could be outdated or wrong

  Do NOT use for: questions answerable from the code in front of you, or
  opinion/preference calls with no factual answer.
---

# Researcher

Verify before you rely. This skill turns "I think X" into "X, confirmed against
its source" — because a confident wrong fact costs more than an honest unknown.

## When this fires

- "Is X still maintained / supported?"
- "What's the best library for…?"
- "Does this API / endpoint exist?"
- "What's the latest version of…?"
- "How does X actually work?"
- Before recommending any third-party package or service
- Before making an architectural decision on an assumed fact

## Step 1 — Define the question

Write down exactly what you need to know before searching:

- The **specific claim** to verify.
- What would **prove it true**, and what would **prove it false**.
- The **minimum viable answer** needed to proceed.

## Step 2 — Research by type

**Package / library**
1. Official docs (not just the README).
2. Registry (npm/PyPI/pub.dev) last-publish date.
3. GitHub issues for known bugs or abandonment signals.
4. Download trend (npmtrends.com).
5. Compatibility with the project's current dependency versions.

**API / endpoint**
1. Official API reference (not blog posts).
2. Verify path, method, required headers.
3. Deprecation notices or version changes.
4. Test with a minimal request if possible.
5. Note rate limits, auth, pricing.

**Best practices**
1. Prioritize: official docs > framework-team blogs > reputable devs.
2. Check the publish date — anything older than 18 months needs re-verification.
3. Match the current framework version — old tutorials show deprecated patterns.
4. Cross-reference ≥2 independent sources.

**Comparison / selection**
1. List all serious candidates (don't skip unpopular-but-better options).
2. Evaluate on maintenance, community, bundle size, DX, license.
3. Check whether the existing stack already solves it.
4. Prefer boring, proven tools unless there's a clear reason not to.

## Step 3 — Validate before concluding

```
□ Source is official or authoritative
□ Dated within the last 12 months (or genuinely timeless)
□ Matches the specific version in use
□ Cross-referenced against ≥1 other source
□ Interpreted correctly in this context
```

Any `NO` → find a better source or explicitly flag the uncertainty.

### Step 3B — Verify each claim against its source of truth

Every claim type has a mechanical check — verify by *reading the source*, not by
recalling how things usually are:

| Claim type | Source of truth | How |
|---|---|---|
| Package exists | The registry (npm/PyPI/crates/pub.dev) | Look up the exact name — 19.6% of model-suggested packages are hallucinated |
| Version / feature-in-version | Registry + changelog/release notes | The feature must appear in that version's changelog or tag diff |
| API shape (method, params, return) | Official reference for the *pinned* version | Compare name-by-name; never trust "should look like" |
| Maintenance status | Release cadence + issue/PR triage activity | Last release date alone lies; check whether issues get answered |
| Performance claim | A primary benchmark (repo, paper, vendor bench) | A blog post repeating a number is not a source |
| Security claim | CVE / advisory databases (GHSA, NVD) | Search the package name, check affected-version ranges |
| Best practice | ≥2 independent, current sources | One vendor's docs is a vendor position, not a practice |

**When you cannot verify:** say so explicitly; downgrade the claim to what you
*can* verify; never decorate an unverified claim with confident language —
"should", "appears to", or a direct question to the user beats a fluent
hallucination.

## Reporting format

```markdown
## Research: [Topic]

**Question:** what exactly was investigated
**Finding:** the clear answer in 1–2 sentences
**Confidence:** High / Medium / Low — and why

**Sources:**
- [Source] — [what it confirmed] — [date if relevant]

**Caveats:** anything that changes the answer in a different context

**Claims ledger:** checked: N · verified: V · contradicted: C · unverifiable: U
(counts reconcile with the sources; an unverifiable claim is reported as such,
never silently promoted to a finding)

**Recommendation:** what to do based on the findings
```

## Core principles

- **Never assume** — if you don't know for certain, say so and research.
- **Never use outdated info** — always check source dates.
- **Flag uncertainty** — "I believe X but haven't verified" beats silent guessing.
- **Prefer primary sources** — official docs > Stack Overflow > blog posts.
- **Version-match everything** — Angular 17 advice ≠ Angular 19 advice.

## What this skill does not do

- Verify the project's *own* docs against its code — that's `docs-accuracy` (`DOC-*`).
- Make the decision for you — it supplies verified facts; the architecture call is separate.
- Replace running the code — a claim you can test, test.

## Success criteria

Working when: every third-party claim ships with a source and a confidence
level, unverifiable claims are labelled (not dressed up), and no recommendation
rests on an outdated or hallucinated fact.

## Troubleshooting

- **Source unreachable** (private dep, paywalled): apply the cannot-verify
  protocol — downgrade to what you can confirm, say what you couldn't.
- **Sources conflict:** prefer the primary and the more recent; report the
  conflict rather than picking silently.
