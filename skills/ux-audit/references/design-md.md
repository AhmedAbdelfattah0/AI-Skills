# DESIGN.md — identity discovery and approval boundary

Use this reference to locate, validate, or create the target project's identity contract before selecting rules or proposing fixes.

## Locate the contract

Treat the audited application as the target project; it is not the skill-library repository.

1. Check `<target-root>/DESIGN.md`.
2. If absent, check `<target-root>/docs/DESIGN.md`.
3. If both exist, use the root file and report that the docs copy was not selected.
4. Record the exact source used in the audit report.

Read the selected file without changing it. Parse `project_type` and the
`LOCKED` and `FLEXIBLE` sections. Accept ordinary Markdown or front matter, but
do not infer a LOCKED value from a FLEXIBLE note.

Required LOCKED fields are:

- logo asset or approved wordmark treatment;
- brand colors as hex values;
- primary font;
- tone of voice;
- signature layouts or components;
- direction: `LTR`, `RTL`, or `both`.

`project_type` accepts one or more of `consumer`, `e-commerce`,
`dashboard/admin`, and `SaaS onboarding`. They load `ETH`, `ECOM`, `DASH`, and
`ONB`, respectively. Core sections 1–16 and `ID` always load.

If a present file omits a required LOCKED field or `project_type`, list all
missing values as one bundled set of questions. Do not rewrite, normalize, or
complete the user's file without explicit consent. Continue only when the
loaded packs and identity boundary are unambiguous; otherwise the affected
checks are coverage gaps.

## Missing DESIGN.md

First inspect the project read-only and prepare detected defaults:

- likely logo asset paths;
- CSS custom properties, theme files, and recurring brand-color hex values;
- declared `font-family` values;
- `<html dir>`, locale routing, and i18n configuration;
- whether a distinct dark theme exists.

Then ask one bundled interview in a single message. Present detected values as
defaults for confirmation rather than making the user retype them:

1. Which logo or wordmark is locked?
2. Which brand colors are locked? Supply hex values.
3. What is the primary font?
4. What tone of voice must remain recognizable?
5. Which layouts or components are signature and untouchable?
6. Is direction `LTR`, `RTL`, or `both`?
7. Which project types apply: consumer, e-commerce, dashboard/admin, SaaS onboarding? Multiple are allowed.
8. Is anything else untouchable?

Stop after that message. Before the answers arrive, capture nothing, create no
run directory, and write neither DESIGN.md nor audit artifacts. After the user
answers, show the resolved values and create `<target-root>/DESIGN.md` only with
their consent. Never overwrite either accepted location without explicit
consent.

## Creation template

Use this shape. Remove comments and replace every placeholder with a confirmed
answer; use `none` when the user explicitly says a field has no locked value.

```markdown
---
project_type:
  - consumer
  # also: e-commerce, dashboard/admin, SaaS onboarding
---

# Design contract

## LOCKED

- **Logo:** <asset path or approved treatment>
- **Brand colors:** <#RRGGBB, ...>
- **Primary font:** <family>
- **Tone of voice:** <description>
- **Signature layouts/components:** <list>
- **Direction:** <LTR | RTL | both>

## FLEXIBLE

- **Spacing:** may be normalized within the identity boundary
- **Secondary colors:** may be derived from the brand colors
- **Radii:** may be consolidated
- **Shadows:** may be consolidated
- **Motion:** may be tuned for purpose, performance, and accessibility
- **Component styling:** may be refined without replacing signature components
```

When `project_type` is expressed in a clear header rather than front matter,
preserve that representation. The report must still record the parsed values
and loaded packs.

## LOCKED failures

Rules `ID-01` and `ID-02` govern every recommendation. If a LOCKED item fails:

- report the applicable rule failure;
- set `identity-safe: no`;
- propose only the minimal compliant variant, such as the nearest
  hue-preserving OKLCH shade that reaches the required contrast;
- require owner approval before adoption;
- never propose replacing the logo, brand color, font, voice, signature
  layout, or direction.

A compliant alternative is a review proposal, not permission to modify the
application or DESIGN.md.
