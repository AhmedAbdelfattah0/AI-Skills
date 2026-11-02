# Adapter: code generators (React or HTML prototypes in one project)

For tools that produce code: Claude Code, v0, Lovable, Bolt, a plain Claude artifact page, or any generator that writes files. The design is built as **one project** with one design-system module that every screen imports and one router that connects every screen. This replaces the earlier folder-per-surface format, whose copied design-system files and unlinked folders broke both gates (core-contract.md §1).

Status: the old folder-per-surface variant was proven to preview; this one-project variant has **not yet been run end to end** (verification-protocol.md §2). Record it as untested until it passes.

## Pick the mechanics

- **The user has a codebase or a stack:** build in that stack (its router, its component library, its styling). The structure below still applies; file names follow the repo's conventions.
- **No stack, preview-only:** use what the generator supports natively (v0, Lovable and Bolt create their own projects; follow their structure with the rules below). Only when the target is a plain HTML page with no build step, use the **preview variant**: React 18.3.1 UMD + `@babel/standalone` 7 + plain `<script>` files, as in the tree and skeleton below. External `.jsx` files need HTTP, not `file://` (`python3 -m http.server`).

## One project (shown in the preview variant; map each part to the real stack's equivalent)

```
{Project}/
  index.html                  the one entry: fonts, design-system/*.css, then the scripts below in order
  design-system/              built ONCE by prompt 01 from 01-DESIGN.md; never copied, never edited by a section prompt
    tokens.css                CSS custom properties only
    styles.css                class-based component styles, logical properties
    icons.jsx                 <Icon name size />
    components.jsx            every shared primitive + approved variants + STATUS map
    style-guide.jsx           the living style guide, a route like any other
  app/
    data.js                   mock data as window globals; sections append to data-{section}.js
    i18n-{lang}.js, i18n.js   one dictionary per language, merged into window.makeT(lang)
    layouts.jsx               every shell from 02-APP-MAP.md (main shell, full-screen editor, auth)
    shared.jsx                cross-section components from 02-APP-MAP.md (e.g. MediaPicker), each with its owner noted
    store.jsx                 shared journey state (React context) for flows that cross screens
    App.jsx                   the one router: route map, layouts, providers, review tools
  sections/{section}/
    pages-{section}-N.jsx     screens of this section (~400 lines max per file, a header comment lists its screen keys)
    components-{section}.jsx  components used only by this section
    styles-{section}.css      styles used only by this section, tokens only
```

## Rules to put in 00-Orientation.md

Rules 1-4 and 7-8 apply to every stack; file names are the preview variant's, so map them to the real stack's equivalents (its router file, its shared-components folder, its state store). Rules 5-6 are preview-variant only; in a real stack use its router and module system.

1. **One project, one entry, one router.** Every screen key in `02-APP-MAP.md` is a route in the one router (`App.jsx` in the preview variant). A section prompt adds its routes; it never creates another entry file or project folder.
2. **The design system is referenced, not copied.** Every screen uses `design-system/` components by name. A section needing something new adds it to `components-{section}.jsx` if only it uses it, or proposes a new shared variant as a scoped amendment to `01-DESIGN.md` (core-contract.md §7).
3. **Shared components live once** in `app/shared.jsx`. A section that uses one imports it; it never re-implements it.
4. **Shared journeys** keep their data in `store.jsx`, so navigating away and back keeps a draft or a picked image.
5. **Routing (preview variant):** `route = { page, params }` in the URL hash; `ROUTES` maps screen keys to `{ layout, component, navParent }`; unknown keys render 404. Section prompts register through the marked seams below.
6. **No bundler (preview variant):** every `.jsx` loads with `<script type="text/babel">` and ends with `Object.assign(window, { … })`; data and i18n files are plain scripts.
7. **Review tools** (not product UI, `className="no-print"`): a screen launcher listing every screen key by section; a State switch (Default / Loading / Empty / Error plus domain states); language and role switches where they apply.
8. **Deliver only the files the prompt names.** Files stay readable (~400 lines), split by domain.

## Seams prompt 02 creates (so sections extend instead of regenerating)

In a real stack, the equivalents are: the route table with placeholder routes, nav as data, and the files sections append to; the insertion comments below are preview-variant only.

- `ROUTES` with every screen key from `02-APP-MAP.md`, each pointing at a `ComingSoon` placeholder until its section prompt runs.
- `NAV` and `LAUNCHER_GROUPS` as data, so sections never edit the shell markup.
- Comment markers at the end of `data.js`, `shared.jsx` and every `i18n-{lang}.js` (`/* SECTION DATA BELOW */`).
- Preview variant: in `index.html`, four insertion comments: DATA (section data files right after `data.js`), LOCALES (before `i18n.js`), SECTION COMPONENTS (before `App.jsx`), SECTION PAGES (before `App.jsx`).

## index.html skeleton (preview variant)

```html
<!DOCTYPE html>
<html lang="en" dir="ltr">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{Project}</title>
  <link href="https://fonts.googleapis.com/css2?family=…&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="design-system/tokens.css" /><link rel="stylesheet" href="design-system/styles.css" />
  <!-- SECTION STYLES: sections/{section}/styles-{section}.css go here -->
</head>
<body>
  <div id="root"></div>
  <script src="https://unpkg.com/react@18.3.1/umd/react.development.js"></script>
  <script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js"></script>
  <script src="https://unpkg.com/@babel/standalone@7.29.0/babel.min.js"></script>
  <script src="app/data.js"></script>
  <!-- DATA: sections/{section}/data-{section}.js go here, right after data.js -->
  <!-- LOCALES: every i18n-{lang}.js (and section extensions) go here, before i18n.js -->
  <script src="app/i18n-en.js"></script>
  <script src="app/i18n.js"></script>
  <script type="text/babel" src="design-system/icons.jsx"></script>
  <script type="text/babel" src="design-system/components.jsx"></script>
  <script type="text/babel" src="design-system/style-guide.jsx"></script>
  <script type="text/babel" src="app/store.jsx"></script>
  <script type="text/babel" src="app/shared.jsx"></script>
  <script type="text/babel" src="app/layouts.jsx"></script>
  <!-- SECTION COMPONENTS: sections/{section}/components-{section}.jsx go here -->
  <!-- SECTION PAGES: sections/{section}/pages-{section}-N.jsx go here, all before App.jsx -->
  <script type="text/babel" src="app/App.jsx"></script>
</body>
</html>
```

## Adapter header for each prompt

```markdown
> Tool: code generator. Project: the one {Project}/ the user opened for prompt 00 (01 builds design-system/ first; extend it, never start another).
> Use design-system/ components by name; add this section's files under sections/{section}/;
> register screens through the ROUTES / NAV seams and the project's entry (the index.html insertion comments in
> the preview variant; the stack's own router and imports otherwise).
> Deliver only the files listed below. Do not regenerate or restyle any other file.
```

## Verification lines for every section prompt

- [ ] Only the files the prompt names were added or edited
- [ ] Every screen key of this section is a route and reachable from the nav or the launcher; links to other sections work both ways
- [ ] No design-system value or shared component was copied into the section
- [ ] Every data screen honours the State switch
- [ ] Responsive at 375, 768 and 1440px; tokens only
- [ ] Bilingual: every string from `t()`, `dir` flips, logical CSS only, numbers LTR
