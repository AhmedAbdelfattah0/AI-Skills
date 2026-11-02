# Splitting a large section into part 1 + part 2

Output degrades when one prompt carries more than ~15-18 screens or one screen carries a giant tool (a scheduling calendar, a sales wizard). Split such a section into two prompts that build into the **same container**, the same as every other prompt (core-contract.md §1, G2).

## Rules

- **Split by the user's mental model**, not alphabetically: e.g. "Operations and schedule" vs "Money, programs and events". Put the section's heaviest daily screen in part 1.
- **Prompt 02 (app shell) already created every screen key as a placeholder**, so both parts replace placeholders; neither adds nav items or routes the map does not list.
- **Part 1** owns its screen keys and creates any section-only components and data the part-2 screens will also use; it leaves the seams the adapter defines (for code: data and i18n markers, index insertion comments; for a canvas: the shared section components part 2 will mount).
- **Part 2 is written update-style**, with the same Binding block (core-contract.md §4):

```markdown
# Prompt {N} of {M} — {Section}, part 2: {Scope}

> {Adapter header.} Run AFTER prompt {N-1}. Extends the existing {container}: this is an
> update. Replace only the placeholders for the screen keys below and make only the listed
> edits. Do not regenerate, restyle or rewrite any screen, component or file from part 1 or
> from any other section, except the listed state additions to a shared journey artboard or file.

## Binding
{as in core-contract.md §4, owning only the part-2 screen keys}

## Recap {task context, 3-5 lines}

## New files / artboards
{per the adapter: e.g. sections/{section}/pages-{section}-3.jsx … or {section}-{screen}.dc.html for each key}

## Exact edits to existing files
{only what the adapter's seams require: data and locale extensions, route registration; list each edit}

## Complete screen list / Key screen details / Mock data / Proposals / Deliverable
{as in any section brief}
```

- **A later section that shows screens already designed elsewhere** (a super admin seeing orders across branches) **mounts or imports the existing screen components and adds only the difference** (a branch filter, a column), as a shared component listed in `02-APP-MAP.md`. It never copies them. If the difference is too large for a prop or a variant, it is a new screen that reuses the same shared parts, and the brief says which.
