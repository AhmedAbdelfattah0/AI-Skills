# Prompt 01 template: Foundation (design system + component library)

Always prompt 01 in a greenfield set with more than two surfaces. It produces `{Project}-Foundation/`, which every later surface copies unchanged (`tokens.css`, `styles.css`, `icons.jsx`, `components-core.jsx`). This is what makes 10+ independently generated surfaces look like one product. It doubles as a clickable style guide for the PO.

Meet the [depth standard](depth-standard.md): list every primitive with its variants and a complete STATUS map; a thin Foundation produces thin surfaces.

## Skeleton

```markdown
# Prompt 01 of {M} — Foundation: Design System and Component Library

> Run AFTER prompt 00. Produces ONE folder: `{Project}-Foundation/`

## What this is
{2-3 lines: the shared design system every surface copies + a living style guide.
Restate the product in one sentence and the brand essentials (primary, accent, fonts,
key owner rules from the brand contract, e.g. which colour may fill the primary button in the app).}

## Files to deliver
{folder tree: html, tokens.css, styles.css, data.js, i18n files, icons.jsx,
components-core.jsx, components-shell.jsx (style-guide shell), pages-1..4.jsx
(foundations / actions+inputs+forms / status+data+feedback+overlays / navigation+shell
samples+imagery), App.jsx}

## tokens.css (CSS custom properties only)
{Name every group explicitly: brand scale, primary/hover/soft/on-primary, accent,
neutrals (bg, sunken, surface, raised, tinted, text x4, border x3), dark surfaces
(sidebar, hero gradient), status x5 each with -bg/-text/-border, CATEGORY colours for
the product's core object types (e.g. lesson types, order sources, ticket kinds), type
families + scale + leading + weights, 4px space scale, radius, shadow (incl. focus
rings per surface family), motion (durations, easings), [dir="rtl"] font switch,
prefers-reduced-motion.}

## components-core.jsx
{Numbered list of primitives with ALL variants and states: Button, Field + every
input type the product needs (phone, money, date/time, combobox, chips, file/crop,
rich text), Badge/StatusPill driven by one STATUS map, Card family, KPI/StatCard with
icon + delta + sparkline + accent variant, DataTable that stacks into labelled cards
below 768px + skeleton, Tabs, FilterBar, Modal that becomes a BottomSheet on phones,
Drawer with stacked back header, ConfirmDialog with optional required reason, Menu,
Toast + host, EmptyState with illustration slot, ErrorState, Banner, Avatar/PersonCell,
Stepper/Timeline, Progress bar/ring, Money/DateTime/Countdown formatters, small charts,
and the product's DOMAIN components (e.g. LessonCard, ProductCard, CalendarEvent).}

## One status language (STATUS map)
{Every status enum the product has, each mapped to ONE tone (success, warning, danger,
info, neutral, accent). Pull the enums from the codebase inventory; if the current app
colours the same status differently on different pages, say so and fix it here.}

## Showcase pages
{Numbered list of style-guide pages routed by App.jsx: overview (moods, principles,
why the old UI felt bland), colour, type (flag new font choices "Proposal for PO
approval"), space/radius/shadow/motion, buttons, inputs, forms (a realistic domain
form), status map table, data display, feedback, overlays, navigation (each shell
family), domain components, imagery.}

## Translation glossary (bilingual only)
{25-40 rows of the customer vocabulary reused across surfaces.}

## Deliverable
{folder + verification: every component in every state, STATUS map complete, table
stacking and bottom sheet at 375px, RTL flips, tokens only, proposals flagged.}

After delivery, reply: "Foundation complete. Ready for prompt 02 ({next})."
```

## Every later surface prompt must say

> Copy `tokens.css`, `styles.css`, `icons.jsx` and `components-core.jsx` from `{Project}-Foundation/` **unchanged**. Put surface-specific styles in `styles-{surface}.css`, extra icons in `icons-{surface}.jsx` (merged into the icon map with `Object.assign`) and surface components in `components-{surface}.jsx`. Reuse Foundation components by name.

The STATUS map must cover **every** status any surface will render (take the full enum list from the inventory or Discovery), and use only the tones Foundation declares, because surfaces may not edit `components-core.jsx` later.
