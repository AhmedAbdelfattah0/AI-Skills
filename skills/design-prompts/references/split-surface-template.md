# Splitting a large surface into part 1 + part 2

Claude Design output degrades when one prompt carries more than ~15-18 pages or one page carries a giant tool (a scheduling calendar, a sales wizard). Split such a surface into two prompts that build ONE folder.

## Rules

- **Split by the user's mental model**, not alphabetically: e.g. "Operations and schedule" vs "Money, programs and events"; "Oversight and catalog" vs "Sales, accounts and system". Put the shell and the heaviest daily page in part 1.
- **Part 1 creates the folder and the whole shell**, including nav items for part-2 pages. Those routes render a `coming-soon` placeholder page. Part 1 must define the seams part 2 plugs into:
  - `ComingSoonPage`, `NotFoundPage`, `NoAccessPage` in `pages-1.jsx`
  - a marked placeholder block in `SHELL_PAGES` and a `PART2_KEYS` array
  - `LAUNCHER_GROUPS` and `NAV_PARENT` as data (not hard-coded JSX)
  - comment markers (`/* PART 2 DATA BELOW */`) at the end of `data.js` and **every** `i18n-{lang}.js`, and the three HTML insertion comments (LOCALES before `i18n.js`, COMPONENTS before the shell, PAGES before `App.jsx`) from the component-format skeleton
  - nav badges read from data (`{PREFIX}.navBadges`) so part 2 can set them without touching the shell
- **Part 2 is written update-style** (ALL CAPS scope discipline from Appendix H, but at surface size):

```markdown
# Prompt {N} of {M} — {Surface}, Part 2: {Scope}

> Run AFTER prompt {N-1}. Extends the existing folder `{Project}-{Surface}/` created by
> prompt {N-1}. This is an **update**: add the new files listed below and make only the
> listed edits to existing files. Do not regenerate, restyle or rewrite any part-1 page,
> component or file.

## Recap {self-contained, 5-8 lines}

## New files
{pages-12.jsx … pages-N.jsx with their page keys, styles-{surface}-2.css, data-2.js /
i18n-{lang}-2.js for EVERY locale if data is large, components-{surface}-2.jsx}

## Exact edits to existing files
- HTML: add locale extensions at the LOCALES insertion point (before `i18n.js`), new component files at COMPONENTS, new pages at PAGES (before `App.jsx`), new stylesheets after the last `<link>`; list each tag in order …
- App.jsx: add these keys to SHELL_PAGES / FULL_PAGES; empty PART2_KEYS; add launcher groups …
- data.js and every i18n-{lang}.js: append after the marker (the same keys in every locale) …
- components-shell.jsx: {only if unavoidable, list the exact change}

## Complete page list / Key page details / Mock data / Deliverable
{as in any surface prompt}
```

- The next surface that needs the same pages (e.g. a super admin seeing orders across branches) should **copy the page components from the earlier folder** and add only the difference (a branch filter, a column). Say so explicitly, or Claude Design will redesign them thinly from scratch. List their dependencies too: the `components-{surface}.jsx` pieces they use, the `data.js` globals they read (alias the global prefix if it differs), the i18n keys, and any routes they link to; say for each whether it is copied, aliased, or replaced by the receiving surface's own.
