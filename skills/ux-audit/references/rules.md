# UX/UI Audit Rules Reference

**Check method:** `A` = automated (script/axe/CSS scan) · `V` = visual (screenshot review) · `M` = manual (interaction test or code read)
**Default severity:** `C` Critical · `H` High · `M` Medium · `L` Low. Adjust per context, e.g. a checkout issue ranks higher than the same issue on an About page.
**Column note:** `M` in **Check** means manual; `M` in **Sev** means Medium.

This catalogue is the sole source of UX audit rule IDs, check methods, and default severities.

## Contents

1. [Accessibility](#1-accessibility--wcag-22-aa-a11y)
2. [Usability heuristics](#2-usability-heuristics--nielsen-heur)
3. [Cognitive laws](#3-cognitive--behavioral-laws-law)
4. [Gestalt](#4-gestalt-principles-gst)
5. [Visual system](#5-visual-design-system-vis)
6. [Hierarchy](#6-layout--visual-hierarchy-hier)
7. [Navigation](#7-navigation--information-architecture-nav)
8. [Interaction](#8-interaction--feedback-int)
9. [States](#9-system-states-state)
10. [Forms](#10-forms--input-form)
11. [Content](#11-content--microcopy-copy)
12. [Responsive](#12-responsive--mobile-resp)
13. [RTL and localization](#13-rtl--localization-i18n)
14. [Motion](#14-motion--animation-mot)
15. [Performance](#15-performance-as-ux-perf)
16. [Modern conventions](#16-modern-conventions-mod)
17. [Ethics](#17-trust-ethics--dark-patterns-eth--load-for-any-consumer-product)
18. [E-commerce](#18-e-commerce-pack-ecom)
19. [Dashboard](#19-dashboard--admin-pack-dash)
20. [Onboarding](#20-onboarding--help-onb)
21. [Identity](#21-identity-preservation-id--always-load-these-gate-every-finding)

**Loading order:** always load Core sections 1–16 and section 21 (`ID`); load domain packs 17–20 by the `project_type` recorded in DESIGN.md.

---

# CORE

## 1. Accessibility — WCAG 2.2 AA (`A11Y`)

| ID | Rule | Check | Sev |
|---|---|---|---|
| A11Y-01 | Body text contrast ≥ 4.5:1; large text (≥24px, or ≥18.66px bold) ≥ 3:1 (1.4.3) | A | C |
| A11Y-02 | UI components, icons, input borders, focus rings ≥ 3:1 against adjacent colors (1.4.11) | A | H |
| A11Y-03 | Color is never the only carrier of meaning (errors, status, links in text, chart series) (1.4.1) | V | H |
| A11Y-04 | Every interactive element is reachable and operable by keyboard (2.1.1) | M | C |
| A11Y-05 | No keyboard traps; modals trap focus while open and return it on close (2.1.2) | M | C |
| A11Y-06 | Focus indicator always visible and clearly styled; never `outline: none` without a replacement (2.4.7) | A/V | H |
| A11Y-07 | Focused element is not hidden behind sticky headers, footers, or cookie bars (2.4.11) | M | H |
| A11Y-08 | Focus order follows the visual/logical order, including in RTL (2.4.3) | M | H |
| A11Y-09 | Target size ≥ 24×24px minimum (2.5.8); aim for 44×44 (iOS) / 48×48 (Material) on touch | A | H |
| A11Y-10 | Skip link or landmarks let users bypass repeated blocks (2.4.1) | A | M |
| A11Y-11 | Each page has a unique, descriptive `<title>` (2.4.2) | A | M |
| A11Y-12 | `lang` set on `<html>`, and on inline content in another language (3.1.1/3.1.2) | A | M |
| A11Y-13 | Images have meaningful `alt`; decorative images use `alt=""` (1.1.1) | A | H |
| A11Y-14 | Controls expose name, role, and value; icon-only buttons have accessible names (4.1.2) | A | C |
| A11Y-15 | Semantic structure: one `h1`, no skipped heading levels, real lists, tables, and landmarks (1.3.1) | A | M |
| A11Y-16 | Every form input has a programmatic label, not only a placeholder (3.3.2) | A | C |
| A11Y-17 | Errors are identified in text and linked to their field (3.3.1); suggestions are given (3.3.3) | M | H |
| A11Y-18 | Status messages (added to cart, saved, n results) are announced via live regions (4.1.3) | M | M |
| A11Y-19 | Content reflows at 320px width with no 2D scrolling (1.4.10) | V | H |
| A11Y-20 | Page usable at 200% text zoom (1.4.4); survives increased text spacing (1.4.12) | A | M |
| A11Y-21 | Hover/focus popovers are dismissible, hoverable, and persistent (1.4.13) | M | M |
| A11Y-22 | Every drag action has a single-pointer alternative (2.5.7) | M | M |
| A11Y-23 | Users are not asked to re-enter info already given in the same flow (3.3.7) | M | M |
| A11Y-24 | Login has no cognitive tests; paste and password managers are allowed (3.3.8) | M | H |
| A11Y-25 | Help/contact mechanism sits in a consistent location across pages (3.2.6) | V | L |
| A11Y-26 | Auto-moving content (carousels, tickers) can be paused (2.2.2) | M | H |
| A11Y-27 | Inputs use `autocomplete` tokens for personal data (1.3.5) | A | M |
| A11Y-28 | No images of text except logos (1.4.5) | V | L |
| A11Y-29 | Nothing flashes more than 3 times per second (2.3.1) | V | C |
| A11Y-30 | Custom widgets follow WAI-ARIA APG patterns (tabs, combobox, dialog, menu) | M | H |

## 2. Usability Heuristics — Nielsen (`HEUR`)

| ID | Rule | Check | Sev |
|---|---|---|---|
| HEUR-01 | Visibility of system status: every action gets feedback, and long operations show progress | M | H |
| HEUR-02 | Match with the real world: user language, not internal/dev terms or raw error codes | V | M |
| HEUR-03 | User control & freedom: undo, cancel, back, and close always exist; no dead ends | M | H |
| HEUR-04 | Consistency & standards: same thing looks and behaves the same everywhere; platform conventions followed | V | H |
| HEUR-05 | Error prevention: constraints, confirmations for destructive actions, smart defaults | M | H |
| HEUR-06 | Recognition over recall: options visible, recent items, no memorizing across screens | V | M |
| HEUR-07 | Flexibility & efficiency: shortcuts and bulk actions for experts without hurting novices | M | L |
| HEUR-08 | Aesthetic & minimalist design: every element earns its place; no competing noise | V | M |
| HEUR-09 | Error recovery: plain-language message + cause + how to fix; input is preserved | M | H |
| HEUR-10 | Help & documentation: contextual help where users get stuck, searchable when larger | V | L |

## 3. Cognitive & Behavioral Laws (`LAW`)

| ID | Rule | Check | Sev |
|---|---|---|---|
| LAW-01 | Hick's Law: limit choices per decision point; progressive disclosure for the rest | V | M |
| LAW-02 | Fitts's Law: primary actions large and close to where attention/thumb already is | V | M |
| LAW-03 | Jakob's Law: follow patterns users know from other sites (logo→home, cart top-right in LTR, top-left in RTL) | V | H |
| LAW-04 | Miller's Law / chunking: group info into digestible chunks (phone numbers, card numbers, long forms) | V | M |
| LAW-05 | Tesler's Law: complexity is absorbed by the system, not pushed onto the user | M | M |
| LAW-06 | Doherty threshold: system responds within ~400ms, or shows immediate feedback | M | M |
| LAW-07 | Von Restorff: only the truly important item visually stands out; not everything is highlighted | V | M |
| LAW-08 | Serial position: key nav items and info placed first and last | V | L |
| LAW-09 | Peak-end rule: the peak moment and the ending (confirmation, success) are well crafted | V | M |
| LAW-10 | Goal gradient: progress indicators in multi-step flows; show nearness to completion | V | M |
| LAW-11 | Zeigarnik: incomplete tasks are visible and resumable (drafts, saved carts, setup checklists) | M | L |
| LAW-12 | Aesthetic-usability: polish affects perceived usability, so visual debt is a real UX issue | V | M |
| LAW-13 | Choice overload: large option sets get filters, sorting, and recommended defaults | V | M |
| LAW-14 | Cognitive load: remove unnecessary reading, decisions, and memory demands per screen | V | H |
| LAW-15 | Postel's Law: accept flexible input formats (spaces in phone numbers, Arabic/Latin digits) | M | M |
| LAW-16 | Mental model: navigation and terminology match how users think about the domain | M | H |

## 4. Gestalt Principles (`GST`)

| ID | Rule | Check | Sev |
|---|---|---|---|
| GST-01 | Proximity: related items are closer together than unrelated ones (label↔input gap < field↔field gap) | V | H |
| GST-02 | Similarity: same-function elements share style; different functions look different | V | M |
| GST-03 | Common region: cards/sections group related content with clear boundaries | V | M |
| GST-04 | Figure-ground: overlays, modals, and menus clearly separate from the background | V | M |
| GST-05 | Continuity & alignment: elements align on shared edges; eye flow is uninterrupted | V | M |
| GST-06 | Uniform connectedness: connected elements (steps, timelines) read as one unit | V | L |
| GST-07 | Prägnanz: prefer the simplest form that communicates; avoid decorative complexity | V | L |

## 5. Visual Design System (`VIS`)

| ID | Rule | Check | Sev |
|---|---|---|---|
| VIS-01 | Spacing uses a 4/8px scale; flag every off-scale value | A | H |
| VIS-02 | Fewer than ~10 unique spacing values across the codebase | A | M |
| VIS-03 | Type scale is defined (~5–8 sizes); flag unique font sizes beyond the scale | A | H |
| VIS-04 | Maximum 2 font families; weights limited and purposeful | A | M |
| VIS-05 | Body text ≥ 16px on mobile; line-height 1.4–1.6 for body, tighter for headings | A | H |
| VIS-06 | Line length 45–75 characters for reading content | V | M |
| VIS-07 | Palette is defined as tokens: brand, neutrals (~8–10 steps), semantic (success/warning/error/info) | A | H |
| VIS-08 | No hardcoded hex values outside the token file | A | M |
| VIS-09 | Semantic colors are used consistently (red = error/destructive only) | V | M |
| VIS-10 | Radius scale is limited (e.g. none/sm/md/lg/full) and consistent per component type | A | M |
| VIS-11 | Elevation/shadow scale is limited (~3–5 levels); shadows match the light direction | A | M |
| VIS-12 | Icons come from one family, with consistent stroke, size grid, and optical alignment | V | M |
| VIS-13 | Imagery is consistent in treatment, aspect ratios, and quality; no stretched or pixelated images | V | M |
| VIS-14 | A layout grid is defined (e.g. 4/8/12 columns) with consistent gutters and max-width | V | M |
| VIS-15 | Whitespace is generous enough that content breathes; avoid cramped density unless intentional (admin) | V | M |
| VIS-16 | Borders are used sparingly; prefer spacing/background to separate content | V | L |
| VIS-17 | Components have one source of truth; no near-duplicate button/card variants | A/M | H |

## 6. Layout & Visual Hierarchy (`HIER`)

| ID | Rule | Check | Sev |
|---|---|---|---|
| HIER-01 | One clear primary action per view; secondary/tertiary actions are visually subordinate | V | H |
| HIER-02 | Clear hierarchy through size, weight, color, and space; users know where to look first | V | H |
| HIER-03 | Content is scannable (F/Z pattern): headings, short paragraphs, meaningful labels | V | M |
| HIER-04 | Important content above the fold on key pages without cramming | V | M |
| HIER-05 | Consistent page templates; the same element types sit in the same positions | V | M |
| HIER-06 | Button hierarchy is consistent: primary / secondary / ghost / destructive | V | H |
| HIER-07 | No more than one visually dominant element competing per section | V | M |

## 7. Navigation & Information Architecture (`NAV`)

| ID | Rule | Check | Sev |
|---|---|---|---|
| NAV-01 | Users always know where they are (active state, breadcrumbs, page title) | V | H |
| NAV-02 | Users always know where they can go; nav labels are clear and not clever | V | H |
| NAV-03 | Global nav stays consistent across pages | V | H |
| NAV-04 | Nav depth is reasonable; key destinations are within ~3 clicks/taps | M | M |
| NAV-05 | Search is prominent where content volume warrants it, with autocomplete and typo tolerance | M | M |
| NAV-06 | Browser back works as expected, including in SPAs, filters, and modals (URL reflects state) | M | H |
| NAV-07 | Deep links work; shareable URLs restore the same view | M | M |
| NAV-08 | Mobile nav: bottom nav for 3–5 top destinations or a clear menu; no hidden critical paths | V | M |
| NAV-09 | Links look like links; clickable things look clickable, and non-clickable things don't | V | H |
| NAV-10 | Useful 404 page with search and paths back | V | L |

## 8. Interaction & Feedback (`INT`)

| ID | Rule | Check | Sev |
|---|---|---|---|
| INT-01 | Every interactive element has hover, focus, active, and disabled states | A/V | H |
| INT-02 | Buttons show loading state and block double-submission | M | H |
| INT-03 | Optimistic UI for low-risk actions (like, add to cart), with rollback on failure | M | L |
| INT-04 | Destructive actions need confirmation or offer undo (undo preferred) | M | H |
| INT-05 | Toasts/snackbars for non-blocking feedback; modals only for decisions that need interruption | V | M |
| INT-06 | Modals: close via X, Esc, and backdrop (unless unsaved data); no modal-on-modal | M | M |
| INT-07 | Disabled buttons explain why, or better, stay enabled and validate on click | M | M |
| INT-08 | Cursor/pointer affordance is correct on clickable elements | A | L |
| INT-09 | Scroll position is preserved when returning to lists | M | M |
| INT-10 | No unexpected context changes on focus or input (auto-submit, auto-navigate) | M | H |

## 9. System States (`STATE`)

| ID | Rule | Check | Sev |
|---|---|---|---|
| STATE-01 | Empty states explain what belongs here and offer the next action (not just "No data") | V | M |
| STATE-02 | Loading uses skeletons that match the final layout for content; spinners only for short or unknown waits | V | M |
| STATE-03 | Error states are designed: what happened, why, and what to do (retry, contact) | V | H |
| STATE-04 | Partial-failure states handled (one widget fails, the page still works) | M | M |
| STATE-05 | Success states confirm the outcome clearly (order placed, saved) | V | M |
| STATE-06 | Offline/slow-network behavior is handled gracefully | M | L |
| STATE-07 | No-results state for search/filters offers suggestions or a clear-filters action | V | M |
| STATE-08 | Edge content handled: very long names, missing images, 0/1/many items, large numbers | V | M |

## 10. Forms & Input (`FORM`)

| ID | Rule | Check | Sev |
|---|---|---|---|
| FORM-01 | Labels always visible above fields; placeholders are not labels | V | H |
| FORM-02 | Single-column layout for most forms | V | M |
| FORM-03 | Inline validation on blur (not on every keystroke); errors next to the field | M | H |
| FORM-04 | Correct input types and `inputmode` (email, tel, numeric) trigger the right mobile keyboard | A | M |
| FORM-05 | Required/optional marked consistently; ask only what's needed | V | M |
| FORM-06 | Field width hints at expected input length | V | L |
| FORM-07 | Smart defaults and autofill; country/city preselected where known | M | M |
| FORM-08 | Password: show/hide toggle, requirements visible upfront, paste allowed | M | M |
| FORM-09 | Long forms broken into steps with progress, or grouped into sections | V | M |
| FORM-10 | Input is preserved on error or navigation; nothing gets wiped | M | H |
| FORM-11 | Submit button label describes the action ("Place order", not "Submit") | V | L |
| FORM-12 | Date/phone/address pickers suit the locale and accept flexible formats | M | M |

## 11. Content & Microcopy (`COPY`)

| ID | Rule | Check | Sev |
|---|---|---|---|
| COPY-01 | Clear, concise, action-oriented language; front-load key words | V | M |
| COPY-02 | Consistent terminology (don't mix Cart/Bag/Basket) | V | M |
| COPY-03 | Error messages are human, specific, blame-free, and actionable | V | H |
| COPY-04 | Button/link text is meaningful out of context (no "Click here", no bare "Read more") | A | M |
| COPY-05 | Tone matches the brand voice defined in DESIGN.md | V | M |
| COPY-06 | Numbers, dates, and currency formatted for the locale | V | M |
| COPY-07 | No truncation that hides critical info; tooltips or expansion where truncated | V | M |

## 12. Responsive & Mobile (`RESP`)

| ID | Rule | Check | Sev |
|---|---|---|---|
| RESP-01 | Works at 320, 390, 768, 1024, 1440, and 1920px without breakage | V | C |
| RESP-02 | No horizontal page scroll; wide tables/code scroll inside their own container | V | H |
| RESP-03 | Primary actions within the thumb zone on mobile (bottom half, sticky CTA where appropriate) | V | M |
| RESP-04 | Respects safe areas (notch, home indicator) with `env(safe-area-inset-*)` | A | M |
| RESP-05 | Hover-only interactions have touch equivalents | M | H |
| RESP-06 | Images are responsive (`srcset`/`sizes`, modern formats, explicit dimensions) | A | M |
| RESP-07 | Layout adapts, not just shrinks (content re-prioritized per breakpoint) | V | M |
| RESP-08 | Uses `dvh`/`svh` instead of `100vh` for full-height mobile layouts | A | L |
| RESP-09 | Landscape orientation isn't broken or locked unnecessarily | V | L |

## 13. RTL & Localization (`I18N`)

| ID | Rule | Check | Sev |
|---|---|---|---|
| I18N-01 | `dir="rtl"` set correctly; layout fully mirrors | V | C |
| I18N-02 | CSS uses logical properties (`margin-inline-start`, not `margin-left`) | A | H |
| I18N-03 | Directional icons (arrows, back, chevrons, progress) mirror; non-directional ones (play, checkmarks, logos) don't | V | H |
| I18N-04 | Arabic font is chosen for legibility, with larger size/line-height than Latin equivalents | V | M |
| I18N-05 | Mixed-direction text (numbers, SKUs, emails, English words in Arabic) renders correctly (bidi isolation) | V | H |
| I18N-06 | Layout tolerates text expansion/contraction between languages | V | M |
| I18N-07 | Currency, date, and number formats are correct per market (SAR, BHD, EGP; Hijri/Gregorian where relevant) | V | M |
| I18N-08 | Carousels, sliders, and swipe gestures reverse direction in RTL | M | M |
| I18N-09 | No hardcoded strings; everything goes through i18n | A | M |

## 14. Motion & Animation (`MOT`)

| ID | Rule | Check | Sev |
|---|---|---|---|
| MOT-01 | Motion has purpose: feedback, orientation, continuity; never decoration only | V | M |
| MOT-02 | Durations: micro 100–200ms, UI transitions 200–300ms, large/page 300–500ms | A | L |
| MOT-03 | Easing: ease-out for entering, ease-in for exiting; no linear UI motion | A | L |
| MOT-04 | Respects `prefers-reduced-motion` | A | H |
| MOT-05 | Animate only `transform` and `opacity` for performance | A | M |
| MOT-06 | Consistent motion tokens across the app | A | L |
| MOT-07 | View/page transitions preserve spatial context where helpful (View Transitions API) | V | L |

## 15. Performance as UX (`PERF`)

| ID | Rule | Check | Sev |
|---|---|---|---|
| PERF-01 | LCP ≤ 2.5s (lab measurement; not field Core Web Vitals) | A | H |
| PERF-02 | INP ≤ 200ms when configured interactions run (lab measurement; not field Core Web Vitals) | A | H |
| PERF-03 | CLS ≤ 0.1; reserve space for images, ads, fonts, and async content | A | H |
| PERF-04 | Fonts load without invisible text (`font-display: swap`) and with a metric-matched fallback | A | M |
| PERF-05 | Above-the-fold images prioritized; below-the-fold lazy-loaded | A | M |
| PERF-06 | Perceived speed: skeletons, optimistic UI, prefetch on hover/intent | M | M |
| PERF-07 | Visible feedback within 100ms of input (click/tap/keypress) on configured safe interactions; unconfigured → coverage gap | A | M |

## 16. Modern Conventions (`MOD`)

| ID | Rule | Check | Sev |
|---|---|---|---|
| MOD-01 | Dark mode built from tokens (not inverted); respects `prefers-color-scheme` + manual toggle | A/V | M |
| MOD-02 | Design tokens as CSS custom properties, the single source for theming | A | H |
| MOD-03 | Component-level responsiveness via container queries where components live in varied contexts | A | L |
| MOD-04 | Focus rings use `:focus-visible` (keyboard only, no mouse-click rings) | A | M |
| MOD-05 | Native elements preferred (`<dialog>`, `<details>`, popover API) over heavy custom widgets | A | L |
| MOD-06 | Command palette / keyboard shortcuts for power-user apps | M | L |
| MOD-07 | AI features: clear labeling, loading/streaming states, editable output, easy undo, no fake certainty | M | M |
| MOD-08 | No outdated patterns: heavy drop shadows, gradients on every surface, carousel-as-hero, splash screens, mystery-meat icons | V | M |

---

# DOMAIN PACKS

## 17. Trust, Ethics & Dark Patterns (`ETH`) — load for any consumer product

| ID | Rule | Check | Sev |
|---|---|---|---|
| ETH-01 | No confirmshaming ("No thanks, I hate saving money") | V | H |
| ETH-02 | No pre-checked opt-ins for marketing or add-ons | M | H |
| ETH-03 | No hidden costs revealed only at the last step | M | C |
| ETH-04 | No fake urgency/scarcity (fake timers, fake "3 left") | M | H |
| ETH-05 | Cancel/unsubscribe is as easy as signing up | M | H |
| ETH-06 | Cookie consent: reject is as easy as accept; no dark nudging | V | H |
| ETH-07 | Trust signals present where decisions happen (secure payment, returns policy, reviews) | V | M |
| ETH-08 | Privacy: explain why data is requested at the point of asking | V | M |

## 18. E-commerce Pack (`ECOM`)

| ID | Rule | Check | Sev |
|---|---|---|---|
| ECOM-01 | Product cards: image, name, price, key variant info; consistent aspect ratio | V | H |
| ECOM-02 | Price displayed clearly, with sale/original price distinguished accessibly | V | H |
| ECOM-03 | Filters: visible applied-filter chips, result counts, easy clear-all, persist in URL | M | H |
| ECOM-04 | Sorting options match user intent (price, newest, popularity, rating) | V | M |
| ECOM-05 | PDP: large zoomable gallery, variant selection that updates image/price/stock | M | H |
| ECOM-06 | PDP: delivery estimate, stock status, and returns info near the Add to Cart button | V | H |
| ECOM-07 | Add to cart gives clear feedback (mini-cart, toast, count update) without forcing navigation | M | H |
| ECOM-08 | Cart: editable quantities, remove with undo, total always visible, cost breakdown | M | H |
| ECOM-09 | Guest checkout available | M | C |
| ECOM-10 | Checkout: minimal steps, progress indicator, distraction-free (no main nav) | V | H |
| ECOM-11 | Total cost including shipping and VAT shown before the payment step | M | C |
| ECOM-12 | Payment methods visible early (incl. local: Mada, Apple Pay, Tabby/Tamara, COD) | V | H |
| ECOM-13 | Address form fits the local market (district, landmarks, national address, map pin) | M | M |
| ECOM-14 | Order confirmation: summary, order number, next steps, delivery expectation | V | M |
| ECOM-15 | Search handles synonyms, typos, Arabic/English, and article numbers | M | H |
| ECOM-16 | Wishlist/saved items don't require login upfront | M | L |

## 19. Dashboard & Admin Pack (`DASH`)

| ID | Rule | Check | Sev |
|---|---|---|---|
| DASH-01 | Key metrics first, with context (trend, comparison, target), not bare numbers | V | H |
| DASH-02 | Tables: sticky headers, sortable columns, right-aligned numbers, tabular figures | V | M |
| DASH-03 | Tables: pagination or virtualization, row actions discoverable, bulk actions | M | M |
| DASH-04 | Tables on mobile: card view or priority columns, not a squished grid | V | M |
| DASH-05 | Filters/date ranges persist and are reflected in the URL | M | M |
| DASH-06 | Charts: correct chart type for the data, labeled axes, legends, accessible colors, no 3D/pie abuse | V | M |
| DASH-07 | Density toggle or appropriate density for power users | V | L |
| DASH-08 | Permissions: unavailable actions are hidden or explained, not failing silently | M | H |
| DASH-09 | Audit trail and timestamps visible for important records | V | L |
| DASH-10 | Export options where users need data outside the app | M | L |

## 20. Onboarding & Help (`ONB`)

| ID | Rule | Check | Sev |
|---|---|---|---|
| ONB-01 | First-run experience gets users to value fast; no mandatory long tours | M | M |
| ONB-02 | Empty states double as onboarding | V | M |
| ONB-03 | Contextual tips appear at the moment of need and are dismissible | V | L |
| ONB-04 | Setup checklist for multi-step configuration (SaaS/admin) | V | L |

## 21. Identity Preservation (`ID`) — always load; these gate every finding

| ID | Rule | Check | Sev |
|---|---|---|---|
| ID-01 | No recommendation changes a LOCKED item from DESIGN.md | M | C |
| ID-02 | If a LOCKED color fails contrast, propose the minimal adjusted shade and mark it for owner approval | A | H |
| ID-03 | New tokens are derived from brand colors (tints/shades), not an unrelated palette | V | H |
| ID-04 | Recognizable signature layouts/components are refined, not replaced | V | H |
| ID-05 | Modernization is flagged by risk: token-only (safe) → component restyle → layout change (needs approval) | M | M |
