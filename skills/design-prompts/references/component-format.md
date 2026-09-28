# Component + HTML preview output format (default, proven)

Proven on a multi-tenant e-commerce product (storefront, admin, super admin, marketing, help center) and on a 13-prompt redesign of a 123-page bilingual school-management app. Claude Design renders these folders in its preview, and the PO can click through every screen. Outside Claude Design, serve the folder over HTTP (`python3 -m http.server` or `npx serve`): Babel fetches the external `.jsx` files, which browsers block from `file://`.

Paste this block (adapted: project prefix, surfaces, bilingual or not) into the Master Orientation under "Output format (CRITICAL)", and restate the folder tree inside every surface prompt.

## Folder per surface

```
{Project}-{Surface}/
  {Project} {Surface}.html   preview entry: loads React 18.3.1 UMD, ReactDOM UMD and
                             @babel/standalone 7 from unpkg, Google Fonts, tokens.css,
                             styles.css, styles-{surface}.css, then the scripts below in order
  tokens.css                 CSS custom properties only (colour, type, space, radius,
                             shadow, motion). Copied UNCHANGED from {Project}-Foundation
  styles.css                 shared class-based component styles, logical properties.
                             Copied UNCHANGED from Foundation
  styles-{surface}.css       everything specific to this surface
  data.js                    realistic mock data as window globals (plain script)
  i18n-{lang}.js             one dictionary per language as window globals
  i18n.js                    merges dictionaries, exposes window.makeT(lang)
                             (missing key falls back to English, then to the key;
                             supports {var} interpolation)
  icons.jsx                  <Icon name size /> inline stroke icons. Copied UNCHANGED from Foundation
  icons-{surface}.jsx        optional: extra icons, merged into the icon map with Object.assign
  components-core.jsx        shared primitives. Copied UNCHANGED from Foundation
  components-shell.jsx       this surface's shell: sidebar / topbar / nav / footer
  components-{surface}.jsx   surface-specific components and any extensions of core primitives
  pages-1.jsx … pages-N.jsx  page components grouped by domain, ~400 lines max each,
                             each file starts with a comment listing its page keys
  App.jsx                    hash router, page maps, providers, review tools
```

## Rules to put in the Master

1. **No bundler, no imports or exports.** Every `.jsx` loads with `<script type="text/babel">` and ends with `Object.assign(window, { … })`. `data.js` and `i18n*.js` are plain scripts setting `window.{PREFIX}_*` globals.
2. **Routing:** `App.jsx` keeps `route = { page, params }` in the URL hash. `SHELL_PAGES` maps page keys rendered inside the shell; `FULL_PAGES` maps full-screen pages (sign-in, wizards, checkout). Unknown keys render the 404 page. Detail pages map to a parent nav item (`NAV_PARENT`) so the sidebar highlights correctly.
3. **Providers:** `LangCtx` (`lang`, `dir`, `t`, `setLang`) and `UICtx` (`toast`, `confirm`, `nav`, optionally `openSheet`). `ToastHost` and `ConfirmDialog` render once in `App.jsx`.
4. **Review tools (not product UI, `className="no-print"`):**
   - **Screen launcher:** floating round button at the inline-end bottom corner. Opens a panel listing every page key grouped by section, plus modals/drawers worth reviewing.
   - **State switch** (Default / Loading / Empty / Error) that every data page honours, plus domain states the surface needs (e.g. "hold expired", "payment declined", "locked").
   - **Language switch** on bilingual surfaces; **role / persona switch** where the same pages differ by role.
   - Full-screen surfaces (auth, checkout, mobile phone frames) may use a slim top **demo strip** (dark, blurred, segmented controls) with the same controls instead of, or beside, the launcher.
5. **Mock data** is realistic for the market (local names, currency, phone format, IDs), and sized so tables and calendars look real (20+ rows, a full week of events).
6. **Foundation files are immutable in surfaces.** `tokens.css`, `styles.css`, `icons.jsx` and `components-core.jsx` are copied unchanged; additions go in `styles-{surface}.css`, `icons-{surface}.jsx` and `components-{surface}.jsx`, so a later Foundation fix can be re-copied into every folder.
7. **Deliver only the files the prompt names**, inside its folder. No single-file version, no build tooling, no edits to other surface folders unless the prompt says "extend".
8. Files stay readable (≈400 lines). Split by domain, never by arbitrary size.

## Preview HTML skeleton (give Claude Design this shape)

Load order is a dependency order: data, locale dictionaries, the merge, icons, core, surface components, shell, pages, then `App.jsx` last. The three HTML comments are the insertion points later prompts refer to.

```html
<!DOCTYPE html>
<html lang="en" dir="ltr">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{Project} {Surface}</title>
  <link href="https://fonts.googleapis.com/css2?family=…&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="tokens.css" /><link rel="stylesheet" href="styles.css" />
  <link rel="stylesheet" href="styles-{surface}.css" />
</head>
<body>
  <div id="root"></div>
  <script src="https://unpkg.com/react@18.3.1/umd/react.development.js"></script>
  <script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js"></script>
  <script src="https://unpkg.com/@babel/standalone@7.29.0/babel.min.js"></script>
  <script src="data.js"></script>
  <!-- LOCALES: every i18n-{lang}.js (and any -2 extensions) go here, before i18n.js -->
  <script src="i18n-en.js"></script><script src="i18n-ar.js"></script>
  <script src="i18n.js"></script>
  <script type="text/babel" src="icons.jsx"></script>
  <script type="text/babel" src="icons-{surface}.jsx"></script>       <!-- if present -->
  <script type="text/babel" src="components-core.jsx"></script>
  <!-- COMPONENTS: components-{surface}*.jsx go here, before the shell and pages -->
  <script type="text/babel" src="components-{surface}.jsx"></script>
  <script type="text/babel" src="components-shell.jsx"></script>
  <!-- PAGES: pages-N.jsx go here, all before App.jsx -->
  <script type="text/babel" src="pages-1.jsx"></script>
  <script type="text/babel" src="App.jsx"></script>
</body>
</html>
```

## Verification lines to add to every prompt

- [ ] Exactly the folder and files the prompt names
- [ ] The preview renders in Claude Design (or over local HTTP) and every page key is reachable from the launcher or demo strip
- [ ] Every data page honours the State switch
- [ ] Responsive at 375, 768 and 1440px
- [ ] Tokens only: no hard-coded colours outside `tokens.css` (photos and illustrations excepted)
- [ ] Bilingual: every string from `t()`, `dir` flips, logical CSS only, numbers LTR
