# Prompt 01 template: `01-DESIGN.md`, the one design system

Always prompt 01, whatever the tool or size. It is the authoritative design system (gate G1, core-contract.md §1): the adapter builds it once in the destination as the tool's shared design system, and every later prompt uses its components and tokens by name. It doubles as a clickable style guide for the PO. It is written as plain, tool-neutral markdown so any tool (or a person) can read it; the adapter header on top says how to build it.

Meet the [depth standard](depth-standard.md): list every primitive with its variants and a complete STATUS map; a thin design system produces thin sections.

## Skeleton

```markdown
# {Project} design system

> {Adapter header from the chosen adapter: how to build this once as the shared design system.}

## What this is
{2-3 lines: the one design system every screen uses, plus a living style guide. Product in one
sentence; brand essentials (primary, accent, fonts) and brand-contract rules (e.g. which colour may
fill the primary button). LOCKED brand items from a DESIGN.md / brand doc in the repo stay as they are.}

## Direction
{The inferred direction in plain words and why (motion-and-finish.md §0): e.g. "Calm and quick, flat
with light borders, no decorative effects: a data-heavy internal tool used all day."}
- Approved variants: {the ONLY ways sections may differ, each named: e.g. `dense` (operator tables,
  compact rows), `marketing` (display type, larger spacing). None: say "none".}

## Tokens
{Name every group with values: brand scale, primary/hover/soft/on-primary, accent, neutrals (bg,
sunken, surface, raised, tinted, text x4, border x3), dark surfaces, status x5 each with
bg/text/border, CATEGORY colours for the product's core object types, type families + scale +
leading + weights (per language if bilingual), 4px space scale, radius hierarchy, elevation (per the
finish: flat = borders and tints; soft = layered shadows), focus ring, motion (durations and easings
from motion-and-finish.md §2, only the tiers the direction uses), RTL font switch, reduced motion.}

## Components
{Numbered list of primitives with ALL variants and states: Button, Field + every input type the
product needs (phone, money, date/time, combobox, chips, file/crop, rich text), Badge/StatusPill
driven by the STATUS map, Card family, KPI/StatCard, DataTable that stacks into labelled cards below
768px + skeleton, Tabs, FilterBar, Modal (bottom sheet on phones), Drawer, ConfirmDialog with optional
required reason, Menu, Toast, EmptyState, ErrorState, Banner, Avatar/PersonCell, Stepper/Timeline,
Progress, Money/DateTime/Countdown formatters, small charts, and the product's DOMAIN components
(e.g. LessonCard, ProductCard, CalendarEvent).
For each: its applicable interaction states (motion-and-finish.md §1) and, where it animates, the
chosen behaviour from the catalogue (§3) in one line.}

## One status language (STATUS map)
{Every status enum the product has, each mapped to ONE tone (success, warning, danger, info, neutral,
accent). Pull the enums from the codebase inventory or Discovery; if the current app colours the same
status differently on different pages, say so and fix it here. It must cover every status any
section will show.}

## Style guide screens
{The style guide built inside the same container as the product: overview (direction, principles,
why the old UI felt bland), colour, type (new font choices go under Proposals), space/radius/
elevation/motion, buttons, inputs, forms (a realistic domain form), status map, data display,
feedback, overlays, navigation (each shell), domain components, imagery, and a motion screen where
each chosen behaviour can be triggered, including the reduced-motion version.}

## Translation glossary (bilingual only)
{25-40 rows of the customer vocabulary reused across sections.}

## Proposals (not to build yet)
{Anything new: fonts, colours outside the brand contract, components the product never had.}

## Deliverable
{Built once in the destination per the adapter. Verification: every component in every state,
STATUS map complete, table stacking and bottom sheet at 375px, RTL flips, tokens only, proposals not
built, reduced motion honoured.}

After delivery, reply: "Design system complete. Ready for prompt 02 (App map and shell)."
```

## Every later prompt says

> Use the {Project} design system already built in this {container}: its components by name, its tokens by name, and only its approved variants. Do not restate, copy or restyle it. Anything it lacks goes under Proposals, or becomes a scoped amendment to `01-DESIGN.md`.
