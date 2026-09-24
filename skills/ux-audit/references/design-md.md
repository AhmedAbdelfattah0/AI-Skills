# DESIGN.md — identity derivation and approval boundary

Use this reference to locate, validate, or derive from the code the target project's identity contract before selecting rules or proposing fixes.

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

If a present file omits a required LOCKED field or `project_type`, derive the
missing values from the code as described below, mark them `inferred` in the
report, and never rewrite, normalize, or complete the user's file.

## Missing DESIGN.md: derive, never interrogate

The person running the audit may be new to the project, so the code is the
source of truth and the skill does the discovery. Never stop to ask questions
the repository can answer. Inspect read-only and derive every field with
evidence and a confidence of `high`, `medium`, or `low`:

| Field | Derive from |
|---|---|
| Logo | Image/SVG assets named or placed as logo/brand (`public/brand/`, `assets/logo*`), and what the header renders. |
| Brand colors | Theme config and CSS custom properties (Tailwind `theme`/`@theme`, Sass variables, JS theme), ranked by rendered frequency on primary CTAs, headers, and links in the capture; comments naming a palette "brand" or "primary" raise confidence. Semantic status colors (success/warning/danger/info) are FLEXIBLE unless branded. |
| Primary font | Font loading (`@font-face`, `next/font`, `<link>` to font services), theme `fontFamily`, and the computed family of body and headings. Record each locale's font when they differ. |
| Tone of voice | The actual interface copy: i18n message files, page headings, CTA labels, and empty/error messages. Summarize in a few words (for example "warm, premium, bilingual") and quote two or three representative strings as evidence. |
| Signature layouts | Distinctive sections repeated across routes or visible above the fold on the home page (hero treatment, navigation style, card system), confirmed against screenshots after capture. |
| Direction | `<html dir>`, locale routing, RTL locale files, `[dir=rtl]` or `:dir(rtl)` styles. |
| project_type | Routes and features: checkout/cart/orders → `e-commerce`; public marketing, sign-up or pricing → `consumer`; role dashboards/admin → `dashboard/admin`; first-run setup, welcome or checklist flows → `SaaS onboarding`. Multiple allowed. |
| Dark theme | `.dark`/`[data-theme]` rules, `prefers-color-scheme` queries, theme toggles. |

**Uncertainty is locked, not asked.** A `medium` or `low` confidence item is
treated as LOCKED for the run. The cost of over-locking is a missed
suggestion; the cost of under-locking is a recommendation that damages the
brand. When two candidates compete (for example two palettes for public and
authenticated surfaces), lock both and name the surface each belongs to.

Write the derived contract to `.specs/ux-audit/<run-id>/DESIGN.draft.md` using
the template below, with the evidence and confidence beside each item, and run
the audit against it. Do not write `<target-root>/DESIGN.md` during the run.
At completion, offer to promote the draft to `<target-root>/DESIGN.md`; that
single write needs the user's explicit consent and is optional. Never
overwrite an existing DESIGN.md.

Ask the user only when the code cannot decide a field that changes the audit
(for example no styling source is readable at all); ask that one precise
question, and keep running every lane that does not depend on it.

## Creation template

Use this shape for both the draft and a promoted file. Every LOCKED item
carries its confidence and evidence; use `none` only when the code shows no
such item exists.

```markdown
---
project_type:
  - consumer
  # also: e-commerce, dashboard/admin, SaaS onboarding
---

# Design contract

## LOCKED

- **Logo:** <asset path or approved treatment> — <high|medium|low>; evidence: <file or observation>
- **Brand colors:** <#RRGGBB (surface), ...> — <confidence>; evidence: <source>
- **Primary font:** <family per locale> — <confidence>; evidence: <source>
- **Tone of voice:** <description; quoted strings> — <confidence>; evidence: <source>
- **Signature layouts/components:** <list> — <confidence>; evidence: <source>
- **Direction:** <LTR | RTL | both> — <confidence>; evidence: <source>

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
