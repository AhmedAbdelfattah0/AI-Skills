---
name: researcher
description: >
  Teaches Claude how to research topics thoroughly and validate that information
  is accurate before using it in code, architecture decisions, or recommendations.
  ALWAYS trigger this skill when the user asks to: investigate a library, compare
  frameworks, verify an API exists, check if a package is maintained, look up
  current best practices, validate a technical approach, or whenever Claude is
  about to make a claim that could be outdated or wrong. Research is a crucial
  part of any project — never skip it when accuracy matters.
---

# Researcher Skill

## When to Use This Skill

Trigger on any of these patterns:
- "Is X still maintained / supported?"
- "What's the best library for...?"
- "Does this API / endpoint exist?"
- "What's the latest version of...?"
- "How does X actually work?"
- Before recommending any third-party package or service
- Before making architectural decisions based on assumed facts

---

## STEP 1 — Define the Research Question

Before searching, write down exactly what you need to know:
- What is the **specific claim** you need to verify?
- What would **prove it true**? What would **prove it false**?
- What is the **minimum viable answer** to proceed?

---

## STEP 2 — Research Strategy

### For Package / Library Research
```
1. Check the official docs (not just README)
2. Check npm/PyPI/pub.dev for last publish date
3. Check GitHub Issues for known bugs or abandonment signals
4. Check weekly download trends (npmtrends.com)
5. Verify it works with the project's current dependency versions
```

### For API / Endpoint Research
```
1. Find the official API reference (not blog posts)
2. Verify the endpoint path, method, and required headers
3. Check for deprecation notices or version changes
4. Test with a minimal request if possible
5. Note rate limits, auth requirements, and pricing
```

### For Best Practices Research
```
1. Prioritize: official docs > framework team blogs > reputable devs
2. Check the publish date — anything older than 18 months needs verification
3. Look for the current framework version — old tutorials may show deprecated patterns
4. Cross-reference at least 2 independent sources
```

### For Competitive / Comparison Research
```
1. List all serious candidates first (don't skip unpopular but better options)
2. Evaluate on: maintenance status, community size, bundle size, DX, license
3. Check if the project's existing stack already solves the problem
4. Prefer boring, proven tools over exciting new ones unless there's a clear reason
```

---

## STEP 3 — Validate Before Concluding

Before using any researched fact, run this check:

```
□ Is the source official or authoritative?
□ Is it dated within the last 12 months? (or timeless?)
□ Does it match the specific version being used?
□ Have I cross-referenced at least one other source?
□ Am I interpreting it correctly in this context?
```

If any answer is NO — find a better source or explicitly flag the uncertainty.

### STEP 3B — Verify each claim against its source of truth

Every claim type has a mechanical check — verify by *reading the source*, not
by recalling how things usually are:

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

---

## STEP 4 — Report Findings

Structure your research output clearly:

```markdown
## Research: [Topic]

**Question:** What exactly was investigated

**Finding:** The clear answer in 1-2 sentences

**Confidence:** High / Medium / Low
**Reason for confidence level:** Why

**Sources:**
- [Source name] — [what it confirmed] — [date if relevant]
- [Source name] — [what it confirmed]

**Caveats / Warnings:**
- Anything that might change the answer in different contexts

**Claims ledger:** checked: N · verified: V · contradicted: C · unverifiable: U
(counts must reconcile with the sources listed — an unverifiable claim is
reported as such, never silently promoted to a finding)

**Recommendation:**
- What to do based on the findings
```

---

## Rules

- **Never assume** — if you don't know for certain, say so and research
- **Never use outdated info** — always check dates on sources
- **Flag uncertainty** — "I believe X but haven't verified" is always better than silent guessing
- **Prefer primary sources** — official docs beat Stack Overflow beats blog posts
- **Version-match everything** — Angular 17 advice ≠ Angular 19 advice
