# FRAMEWORKS — stack-aware token analysis and native fixes

Use this reference to distinguish app-authored design decisions from framework defaults and phrase findings in the project's native styling mechanism.

Rendered lanes inspect computed output, so contrast, reflow, focus, target size,
motion, performance, theme, RTL, and screenshot review are framework-agnostic.
Declared-token scanning, off-scale judgment, and fixes are not: the same value
may be a Tailwind utility, a Bootstrap Sass variable, a JavaScript theme token,
or an app-authored CSS literal. Keep declared and rendered counts separate.

## Detection and stack.json

The read-only `stack` lane runs first. It reads root and workspace
`package.json` dependencies and devDependencies; Tailwind, PostCSS, Sass, Less,
Angular, and theme config files; CSS `@import "tailwindcss"`, `@theme`, and
`@tailwind`; Bootstrap Sass imports; `angular.json` style entries; and project
theme files. On the live page it checks CSSOM fingerprints such as `--tw-*`,
`--bs-*`, `.mat-`, `--mat-*`, `--mdc-*`, `.Mui`, `.chakra-`, and hashed classes
typical of styled-components, Emotion, and CSS Modules.

`stack.json` records every coexisting framework with version, confidence, and
evidence; token sources; excluded vendor stylesheets; template globs; and known
spacing, type, and radius scales with their source. Confidence describes the
strength of detection, not audit quality. An optional config `framework`
overrides the detected adapter; record the override and retain contrary
evidence. `templateGlobs` can override the detected template set.

Framework defaults are never findings by themselves. Report only app-authored
deviations. Judge `offScale` against `stack.json.scales` when present, otherwise
use the inferred 4/8 scale. A declared section marked `partial: true` proves
only what it extracted; the remainder is a coverage gap.

## Plain CSS, Sass, and Less

Tokens live in project custom properties, Sass/Less variables, maps, and style
files; literals in those files are app-authored unless evidence identifies a
vendored source. The on-scale reference is the declared scale, otherwise the
inferred 4/8 scale. Phrase fixes as variables or custom properties, not repeated
literals.

Tiny example: `padding: 13px` → `padding: var(--space-3)`.

## Tailwind v3 and v4

For v3, tokens live in literal `theme` and `theme.extend` objects in
`tailwind.config.*`; parse statically and never execute the config. For v4,
tokens live in CSS `@theme` variables such as `--spacing-*` and `--color-*`.
Template `class`/`className` values like `p-[13px]`, `text-[#5b8def]`, and
`rounded-[7px]`, plus inline styles, are app-authored arbitrary values and enter
`declared.arbitrary` with file:line. Tailwind's default or configured scale is
on-scale. Phrase fixes as a standard utility or a theme extension.

Tiny example: `p-[13px]` → `p-3`, or add a named value under `theme.extend`.

## Bootstrap 5

Tokens live in app-authored Sass overrides such as `$spacer`, `$spacers`,
`$font-size-*`, `$border-radius*`, `$box-shadow*`, and `$primary`, plus project
`--bs-*` overrides. Exclude Bootstrap's bundled CSSOM rules from declared counts
and record the bundle in `vendorStylesheets`. Its default `$spacers` values
0, 4, 8, 16, 24, and 48px at a 16px root are on-scale. Phrase fixes as a Sass
variable override or existing Bootstrap utility.

Tiny example: `.card { padding: 13px }` → `class="card p-3"`.

## Angular Material

Tokens live in app-authored Material theme Sass/API configuration and project
overrides of Material/MDC custom properties. Library-emitted `.mat-*`,
`--mat-*`, and `--mdc-*` defaults are vendor values, not findings. Use the
declared Material theme as the scale reference. Extraction is best effort and
every section is `partial: true`. Phrase fixes through the Material theme API or
an app theme token.

Tiny example: a raw brand hex → the configured Material primary palette role.

## MUI and Chakra

Tokens live in app-authored JavaScript or TypeScript theme objects. MUI uses
fields such as `palette`, `spacing`, `typography`, and `shape`; Chakra uses its
theme scales and semantic tokens. Generated `.Mui*` or `.chakra-*` defaults are
vendor output. The app theme is the on-scale reference. Literal extraction is
best effort and each section is `partial: true`. Phrase fixes as theme values or
component-system props.

Tiny example: MUI `sx={{ p: '13px' }}` → `sx={{ p: 2 }}` using theme spacing.

## CSS-in-JS

For styled-components and Emotion, tokens live in theme objects and app-authored
`styled` or `css` template literals; CSS Modules use project module files and
custom properties. Hashed runtime classes identify the mechanism but do not make
generated declarations app-authored. The theme or module token set is the scale
reference. Extraction is best effort and each section is `partial: true`.
Phrase fixes through the theme accessor or module variable.

Tiny example: ``margin: 13px`` → ``margin: ${({theme}) => theme.space.md}``.

## Unknown framework

When evidence cannot select an adapter, write framework `unknown`. Run all
rendered lanes, but mark declared-token counts, off-scale judgments, and native
proposal formatting as gaps. Do not guess authorship from a minified bundle.
Ask for a config `framework` override or source locations as remediation.

Tiny example: recommend “map this value to the project's spacing token” rather
than inventing `--space-3` or a framework-specific utility.

## Proposal contract

`tokens.json.proposal.format` is one of `tailwind-theme`, `bootstrap-sass`,
`css-custom-properties`, or `js-theme`. Its `snippet` renders the proposed token
set in that idiom: Tailwind `theme.extend` or v4 `@theme`, Bootstrap Sass
overrides, JavaScript theme entries, or CSS custom properties. Derive color
tokens from DESIGN.md brand colors and never introduce an unrelated palette.
