---
name: design-prompts
description: Generates structured design prompts for any digital product (SaaS, e-commerce, content, marketplace, mobile, dashboard, marketing site, etc.) in two modes - GREENFIELD (a numbered prompt set for a new design system, master orientation plus per-surface prompts) and UPDATE (a single focused prompt to add or modify one feature without regenerating everything). Trigger when user says - "/design.prompts", "generate design prompts", "create design prompts", "design prompts for [project]", "design brief for [project]", "add [feature] to my design", "update my design with [feature]" - or starts a new design project or wants to extend an existing one. Use when about to feed a design generation tool and a comprehensive prompt is needed instead of ad-hoc instructions. Project-agnostic - works for B2B SaaS, e-commerce, social apps, content platforms, marketplaces, internal tools, dashboards, mobile apps, or any other digital product.

---

# Claude Design Prompts — Reusable Recipe

This skill codifies a proven approach to writing Claude Design prompts: standalone, fully-specified, scope-bounded, with explicit file boundaries and reuse constraints. It produces prompts that yield consistent, high-quality designs across any kind of digital product.

## Two modes

### GREENFIELD MODE
**When**: starting a brand new design project from scratch, or restarting an existing one because previous Claude Design results were inconsistent.
**Output**: a folder of numbered prompt files (`00-Master-Orientation.md`, `01-...md`, etc.) covering all the surfaces of a product.

### UPDATE MODE
**When**: an existing Claude Design project already has its design system, and the user wants to add or modify ONE specific feature/page without regenerating the rest.
**Output**: a single focused `.md` prompt file with explicit scope constraints — "add this only, do not regenerate everything else."

## Mode detection (do this FIRST)

When the skill is triggered, decide which mode applies before asking anything else:

- If the user mentions starting a new project, restarting fresh, or building a full system → **Greenfield**
- If the user mentions adding/updating/modifying/extending an existing design, a specific page or feature, "just this part" → **Update**
- If unclear, ask: "Is this a new project from scratch, or adding a feature to an existing design? I write different kinds of prompts for each."

Then branch to the appropriate process below.

---

## When NOT to use this skill

- The user wants you to GENERATE the design itself (not write a prompt for Claude Design)
- The user has a single-line design need (just write it directly)
- The user wants to debug or critique an existing design (use design review tools instead)
- The user just wants UI copy or icon suggestions (these don't need a structured prompt)

---

# GREENFIELD MODE — Process

Execute these phases in order. The user's input drives every decision — do not invent surfaces, features, or design choices they didn't ask for.

## Phase 1: Discovery

Before writing any prompts, gather the project context. **Use `ask_user_input_v0` if available** for mobile-friendly tap answers. Required inputs:

### 1. Project basics
- **Project name** — short identifier
- **What the product is** — 2-3 sentences. What does it do? Who's the customer? What problem does it solve?
- **Product category** — pick the closest: SaaS app, e-commerce, marketplace, content/media, social, internal tool, B2B platform, consumer mobile app, developer tool, education, healthcare, finance, other

### 2. Audience and market
- **Target users** — who uses it, their context, their level of technical comfort
- **Geographic/cultural context** — does the design need to adapt to specific markets?

### 3. Surfaces needed
Ask which surfaces this design system needs to cover. Don't assume — let the user pick:
- Primary application surface (the main thing users interact with — call it whatever fits: storefront, dashboard, feed, editor, console, etc.)
- Administrative surface (settings/management, if separate from the primary)
- Platform-operator surface (super-admin / internal ops dashboard, for multi-tenant products)
- Marketing/landing page (pre-signup)
- Authentication / onboarding flows
- Transactional communications (emails, push notifications, SMS templates)
- Mobile companion app
- Help center / documentation
- Public/shared views (read-only profile, share link, embed)
- Other (let user specify)

### 4. Variants
- Does any single surface need **multiple visual variants** (e.g., themes the user can pick from, multiple brand expressions of the same surface)? If yes, how many and what differentiates them?

### 5. Languages and locale
- **Primary language** — for UI copy
- **Additional languages** (if any) — and whether any are RTL (Arabic, Hebrew, Persian, Urdu, etc.)
- **Locale considerations** — currencies, date formats, number formats, address formats

### 6. Visual identity
- **Brand colors** — primary, secondary, accent (if known); otherwise propose a palette based on product category and ask for approval
- **Typography preference** — modern sans-serif / classic serif / display / monospace-accent / etc.
- **Mood** — pick from or describe: warm/friendly, austere/professional, playful, editorial/premium, dense/utilitarian, bold/energetic, minimal/spacious, technical/precise, etc.
- **Density** — generous whitespace vs. information-dense

### 7. Output format
- **HTML showcase**: one self-contained HTML file per surface (all pages as `<section id="page-*">` blocks). Easy to review, harder to integrate.
- **Component-based**: separate component files (.jsx/.tsx/.vue/etc.) per page + shared data, i18n, shell modules. Easier to integrate into a real codebase.
- **Mixed**: HTML for marketing/external, components for internal/app surfaces.
- **Other**: user specifies (e.g., Figma-style spec doc, raw CSS framework)

### 8. Known gaps / required pages
- Has the user pre-identified specific pages, states, or features they want covered? Capture them explicitly.
- Common gaps to ask about: forgot password, error states (404/500), empty states, loading states, success states, print views, mobile responsive variants.

### 9. Constraints
- Component library to reuse (Material, Tailwind, shadcn/ui, custom, etc.)
- Accessibility requirements (WCAG AA, AAA, internal standards)
- Performance constraints (low-bandwidth markets, offline-first, etc.)

If the user can't answer some questions, propose reasonable defaults based on product category and explicitly note them as defaults so they can override.

## Phase 2: Plan the prompt set

Based on Discovery, decide the prompt count and order. The default sequence follows surface-by-surface, with Master Orientation always first:

| # | Prompt | Always? |
|---|---|---|
| 00 | Master Orientation | YES |
| 01-N | One prompt per primary user-facing surface (or per variant of it) | Project-dependent |
| Next | Administrative surface (if separate) | If applicable |
| Next | Platform-operator surface | If applicable |
| Next | Onboarding flow | If applicable |
| Next | Marketing landing page | If applicable |
| Next | Transactional communications | If applicable |
| Next | Mobile companion | Only if requested |
| Next | Other surfaces from Discovery | If applicable |

Each prompt is INDEPENDENT — they don't depend on each other's outputs, only on the Master Orientation establishing shared brand rules.

**Brief the user on the plan before writing.** Example:
> "Plan: 5 prompts total. 00 Master Orientation, 01 Main App (your `dashboard`), 02 Admin Settings, 03 Onboarding, 04 Marketing Page. Each standalone, ~one HTML file each. Sound right?"

Adjust based on their answer. Don't write until they confirm.

## Phase 3: Write the Master Orientation prompt

This is ALWAYS prompt 00. Use **Master Orientation Template** in Appendix A. Replace placeholders with the project's specific values from Discovery.

## Phase 4: Write per-surface prompts

For each surface, use the appropriate appendix as a starting structure, then fill in the specifics from Discovery:

- **Primary application surface** (whatever the main UX is): Appendix B
- **Administrative / management surface**: Appendix C
- **Marketing / landing page**: Appendix D
- **Transactional communications** (emails, push, SMS): Appendix E
- **Onboarding / setup wizard**: Appendix F
- **Mobile companion**: Appendix G

These appendices are SKELETONS, not finished products. Adapt them to the actual product. Don't include sections that don't apply.

Each prompt MUST contain:
1. Header: "Prompt N of M — [Surface Name]" + "Produces ONE file: [exact-filename]"
2. Surface identity (visual tone, distinct from other surfaces in this project)
3. Complete page/section list (numbered, named per the project's conventions)
4. Key page details (sections within each page, states, components)
5. Translation glossary specific to this surface's voice (only if multi-language)
6. Visual + UX requirements
7. Deliverable specification (exact filename, scope boundary)
8. Verification checklist
9. Handshake to next prompt ("After delivery, reply: '[X] complete. Ready for prompt N+1.'")

## Phase 5: Save and deliver

Save all prompts to `/mnt/user-data/outputs/<project-slug>-design-prompts/` with predictable naming. Call `present_files` with all files in order.

End with usage instructions:
> "Open a fresh Claude Design project. Paste 00 first, wait for the orientation confirmation. Then paste 01-N in order. Each produces one file."

---

# UPDATE MODE — Process

Use this when the user wants to add or modify ONE feature in an existing Claude Design project. The output is a single focused prompt, not a folder.

## Phase 1: Update Discovery

Gather what's needed for a tight, scoped prompt:

1. **Which project + which surface?** (e.g., "the admin panel of my HR tool", "the customer dashboard of my SaaS")
2. **What's being added/changed?** — feature name + 2-sentence purpose
3. **Why now / what's the gap?** — what currently exists vs. what's missing
4. **Where in the surface does it go?** — nav placement, position in shell, parent page, route
5. **Layout pattern to match** — is there an existing page in this surface whose structure should be matched? (e.g., "two-panel like the Settings page", "list+detail like the People page", "modal overlay like the Filters")
6. **Components needed** — which existing design system components should be reused? (toggles, color pickers, date pickers, segmented controls, badges, modals, etc.) Avoid inventing new visual language.
7. **States required** — empty, loading, error, success, edit-in-place, locked, disabled, etc.
8. **Cross-cutting rules** — language coverage (matches existing project), validation, scheduling, permissions, dismissibility, etc.
9. **Live preview / interactivity** — does this need a real-time preview panel? Drag-to-reorder? Cycling content? Optimistic updates?

If the user has already written a draft of the feature description (well-formed prose with sections), parse it and only ask follow-ups about gaps.

## Phase 2: Confirm scope

Before writing, restate the scope in one sentence:

> "Writing one update prompt for: **[Feature]** added to the **[Surface]**, placed in the **[Location]**, using the **[Pattern]** layout, with **[Key states]**, matching existing [language] rules. Ready to write?"

This forces the scope to be small and explicit. If the user adds new requirements at this point, integrate them and re-confirm.

## Phase 3: Write the update prompt

Use **Update Prompt Template** in Appendix H. The structure uses ALL CAPS section headers — this makes the prompt scannable and forces Claude Design to treat each section as a hard constraint.

```
# {Feature Name}

CONTEXT: ...
WHERE: ...
PAGE LAYOUT: ...
{Section by section breakdown}
RULES: ...
OUTPUT: ...
```

The OUTPUT clause is the most important part. It explicitly tells Claude Design to add ONLY this feature, NOT regenerate the rest of the design. Phrasings that work:
- "add the new X page consistent with the existing [surface] file structure"
- "extend the existing settings page with X — do not change other sections"
- "add X to the header — keep everything else unchanged"

## Phase 4: Save and deliver

Save to `/mnt/user-data/outputs/<project-slug>-update-prompts/<feature-slug>.md`. Call `present_files`.

End with:
> "Paste this into your existing Claude Design project (the same conversation where you built the original designs). Claude Design will add just this feature to the existing files."

---

## Critical rules — apply to BOTH modes

1. **Every prompt is self-contained.** Do not write "as defined earlier" or "matching prompt 2." Repeat necessary context in every prompt.

2. **Every prompt explicitly forbids file-splitting** (greenfield) or **regeneration** (update). Always include an explicit output-scope clause.

3. **Every prompt names its output file exactly.** No placeholders like `[filename].html` in the final prompt — actual filename derived from the project name.

4. **Every multi-language surface includes a translation glossary** with concrete examples specific to that surface's voice. Skip this section entirely for monolingual products.

5. **Greenfield prompts end with a handshake** so the user knows what to paste next. Update prompts are standalone — no handshake needed.

6. **The user's input drives everything.** Do not invent surfaces, features, or layouts they didn't ask for. Do not skip what they did ask for.

7. **Make prompts feel coherent within a project.** In greenfield, all prompts reference the same brand tokens, typography, and language rules established in the Master Orientation.

8. **Push back if the brief is incomplete.** If the user says "make me a prompt" with no context, ask Discovery questions first — don't guess. Generic prompts produce generic designs.

9. **Project naming carries through.** If the project is "BookFlow", file names are `BookFlow-{surface}.html`. If it's "Helios HR", file names are `Helios-HR-{surface}.html`. The skill never imposes naming conventions from other projects.

10. **Templates are skeletons.** The appendices below are starting structures. Adapt them — don't copy them verbatim. A media app's "primary surface" looks nothing like a B2B dashboard's "primary surface," even though both use Appendix B.

---

## Appendix A — Master Orientation Template (Greenfield)

```markdown
# {PROJECT_NAME} Design System — Master Orientation

> Paste this as the **FIRST message** in a fresh Claude Design project. It establishes context that all subsequent prompts reference. Do not skip this.

## About {PROJECT_NAME}

{1-2 paragraphs explaining what the product is, who the user is, what category it falls in.}

The product surface spans:
{bulleted list of all surfaces this prompt set will cover}

## Visual identity

**Brand colors:**
- Primary: `{HEX}`
- {Secondary tokens — accent, surface, etc.}
- Success/Warning/Danger: `{HEX}` / `{HEX}` / `{HEX}`
- Neutrals: {scale, e.g., gray-50 through gray-900}

**Typography:**
- UI font: {choice — Inter, IBM Plex, system stack, etc.}
- {If multi-language: per-language font choices, e.g., "Arabic UI: Cairo"}
- Display / headings: {weight choice}
- Monospace (for code, IDs, timestamps): {choice}

**Visual style:**
- Density: {generous / balanced / compact}
- Corner radius: {Xpx} on cards, {Xpx} on inputs/buttons
- Shadow style: {soft and low / subtle and sharp / none}
- Mood: {warm / austere / playful / editorial / etc.}

## Voice and tone

{If the product has one consistent voice, describe it once.}
{If different surfaces have different voices (e.g., marketing is persuasive, admin is calm/professional), describe each.}

## Language rules
{Only include this section if multi-language. Otherwise omit entirely.}

Every design surface must support {languages} from day one. The pattern:

1. Every visible string carries `data-i18n="someKey"` attribute
2. Form placeholders use `data-i18n-placeholder="someKey"`
3. An in-page `const T = { {lang1}: {...}, {lang2}: {...} }` dictionary contains every key
4. A language toggle flips `document.documentElement.lang` and replaces all `data-i18n` text content
{If any language is RTL, add these rules:}
5. The language toggle ALSO flips `document.documentElement.dir` between `ltr` and `rtl`
6. CSS uses **logical properties throughout** — `padding-inline-start`, `margin-inline-end`, `inset-inline-start`, `text-align: start` — never `padding-left`, `margin-right`, `left`
7. Numbers, currency, dates, IDs, and code wrap in `<span dir="ltr">` even within RTL content
8. Never mix LTR and RTL text on the same line — keep each language on its own line in mixed-language content

## File output rules (CRITICAL)

1. **Output is ONE file** per prompt, named exactly as the prompt says
2. **Do NOT split into multiple files** unless the prompt explicitly says "deliver as N separate files"
3. **Do NOT generate ancillary files** (separate CSS/JS) — everything inline
4. **Self-contained**: HTML + inline `<style>` + inline `<script>` in a single file (or per output format the project chose)

## Verification standard

Every deliverable must pass:
- [ ] One file (or as specified — never more than what's asked)
- [ ] Mobile responsive at 375px width
- {If multi-language:}
- [ ] Language toggle works — every string changes
- {If RTL:}
- [ ] `dir="rtl"` applies correctly when {RTL language} is active
- [ ] CSS uses logical properties throughout
- [ ] Numbers/currency/IDs stay LTR in RTL context
- [ ] Self-contained — opens directly without external dependencies

## Confirming you're oriented

Reply with: "Oriented. Ready for prompt 1 ({first surface name})."

Do not generate any design until you receive the first specific design prompt. This message is context only.
```

---

## Appendix B — Primary Application Surface Template (Greenfield)

The "primary application surface" is whatever the main user-facing experience of the product is. For e-commerce it's the storefront. For a SaaS app it's the main dashboard. For a content platform it's the feed/reader. For a marketplace it's the browse + transaction surface. **Adapt this template to the project.**

```markdown
# Prompt {N} of {M} — {Surface Name}

> Run AFTER prompt {N-1}. Produces ONE file: `{project-slug}-{surface-slug}.html`

## Surface identity

{1-paragraph description: what the user does on this surface, the primary tasks they accomplish here, the emotional/practical tone the surface should convey.}

**Translation tone** (if multi-language): {specific to this surface — formal/casual/persuasive/contemplative/etc.}

## Complete page list (single file, {X} page sections)

Each page is a `<section id="page-*">` block in the file.

{Group pages by the user's mental model. Common groupings, ADAPT TO THE PROJECT:

### Entry / discovery
- `page-home` or `page-feed` or `page-landing` — {what users see first}
- `page-search` or `page-browse` — {discovery surface}

### Detail / depth
- `page-detail` or `page-item` or `page-profile` — {single-item view}

### Action flows
- `page-create` or `page-compose` or `page-checkout` or `page-book` — {primary action flow}
- `page-confirm` — {post-action confirmation}

### Account / settings
- `page-account` — {user's own data}
- {Other account sub-pages per the product}

### Auth (if hosted in this surface)
- `page-signin`
- `page-signup`
- `page-forgot-password`
- `page-reset-password`

### Utility / public (no auth)
- `page-404` or `page-empty-result` — {error/empty states}
- {Print/share/export views if applicable}
}

## Key page details

{For the most important pages, describe sections, states, and components. Don't over-specify — describe what each page DOES and CONTAINS, not the exact pixel layout. Examples of detail to include per page:}

### `page-{name}` — sections
- {Section 1: purpose, what it contains, primary action}
- {Section 2}
- ...

### `page-{name}` — states
- Default
- Loading
- Empty (when user has no data)
- Error
- Success/confirmation

## Translation glossary

{Only include if multi-language. Provide ~20-40 translations specific to this surface's voice. Group by category — navigation, status terms, actions, content labels.}

| {Lang 1} | {Lang 2} |
|---|---|
| {phrase} | {translation} |
{...}

## Deliverable

**ONE file**: `{project-slug}-{surface-slug}.html`

Verification checklist:
- [ ] All {X} page sections present, each with `id="page-*"`
- {If multi-language: language toggle works}
- [ ] Mobile responsive at 375px
- [ ] {Specific verifications for this surface — e.g., search interactions, drag-and-drop, infinite scroll, etc.}
- [ ] Self-contained

After delivery, reply: "{Surface} complete. Ready for prompt {N+1} ({next surface name})."
```

---

## Appendix C — Administrative / Management Surface Template (Greenfield)

For management dashboards, admin panels, settings consoles, operator surfaces.

```markdown
# Prompt {N} of {M} — {Surface Name}

> Run AFTER prompt {N-1}. Produces ONE file: `{project-slug}-{surface-slug}.html`

## Surface purpose

{1-paragraph description: who manages what on this surface. Multi-tenant or single-org? Self-service or operator-led?}

## Visual identity

{Should usually feel different from the primary user-facing surface — denser, more utilitarian, more data-display oriented. Match the brand colors but apply them more austerely.}

## Complete page list (single file, ~{X} page sections)

### Shell components (always visible across pages)
- Sidebar / nav — {what's in it, primary links}
- Topbar — {what's in it: search, notifications, user menu, language toggle, etc.}
- {Other persistent UI: command palette, notification panel, etc.}

### Main pages (inside shell)
{Numbered list of management pages relevant to the product. Common ones:}
- `page-dashboard` — {KPIs, summary, recent activity}
- `page-{entity}-list` — {list of the entity the surface manages}
- `page-{entity}-detail` — {single entity edit/view}
- `page-{settings-area}` — {grouped settings}
- ...

### Auxiliary pages (outside shell — auth-style centered layout)
{Include only what applies:}
- `page-signin`
- `page-forgot-password`
- `page-reset-password`
- `page-accept-invite` (if collaborators are invited)
- `page-404`
- `page-500`
- `page-empty-workspace` (if applicable: first-time experience)

## Key page details

{Per page: sections, states, components. Be explicit about:}
- Table/list views: columns, filters, sort, pagination, bulk actions, row actions
- Detail/edit pages: sections, form fields, validation, save/discard pattern
- Empty states: what's shown when the user has zero data
- Permission-gated UI: what's hidden vs. disabled for different roles

## Translation glossary
{If multi-language. Estimate key count. Group by page with comment headers.}

## Deliverable

**ONE file**: `{project-slug}-{surface-slug}.html`

Verification checklist:
- [ ] All ~{X} page sections present
- [ ] Shell components work consistently across all pages
- [ ] All auxiliary pages present with all relevant states (default, error, success, expired/invalid, etc.)
- [ ] Empty workspace / first-time state designed
- {If multi-language: language toggle on every page}
- {If RTL: logical CSS properties throughout, numbers LTR in RTL context}
- [ ] Mobile responsive at 375px (sidebar collapses appropriately)
- [ ] Self-contained

After delivery, reply: "{Surface} complete. Ready for prompt {N+1}."
```

---

## Appendix D — Marketing / Landing Page Template (Greenfield)

```markdown
# Prompt {N} of {M} — Marketing Landing Page

> Run AFTER prompt {N-1}. Produces ONE file: `{project-slug}-Landing.html`

## What it is

The pre-signup marketing site visitors see before becoming users. The top-of-funnel asset.

## Visual identity — distinct from in-product surfaces

Generally: more visual, larger typography (display weights), more imagery, more whitespace, more colorful than the in-product UI. Same brand colors so it's recognizable, but a richer expression of them.

## Section list (single page, ~{X} sections)

Adapt to the product. Common SaaS/digital product landing structure:

1. **Navbar** — logo, nav links, sign-in link, primary CTA
2. **Hero** — headline (6-10 words), subheadline (1-2 sentences), 2 CTAs, hero visual, trust strip
3. **Social proof** — customer logos, key stats, testimonial snippet
4. **How it works / features** — 3-6 steps or feature cards
5. **Differentiation / "Why [product]"** — vs. alternatives, the unique value
6. **Deep-dive section** — product screenshots, embedded video, interactive demo
7. **Pricing** — tiers, billing toggle if applicable, comparison table, sales contact
8. **Testimonials / case studies** — quotes with attribution
9. **FAQ** — accordion with common questions
10. **Final CTA** — last push to sign up
11. **Footer** — multi-column with product/resources/company/legal/social links

OMIT sections that don't fit the product. E.g., free tools may not have a pricing section; B2B-only products may downplay social proof in favor of case studies.

## Key section details

{Per section: copy guidance, layout pattern, key components. Be explicit about:}
- Hero: exact headline + subheadline copy (if user knows it)
- Pricing: what tiers, what's in each, billing options
- Testimonials: real names or placeholders with `<!-- TODO: real -->` markers

## Translation
{If multi-language. Persuasive marketing voice.}

## Deliverable

**ONE file**: `{project-slug}-Landing.html`

Verification:
- [ ] Hero above the fold at 1440px and 375px
- [ ] All sections present
- [ ] CTAs visually distinct (primary vs. secondary)
- {If pricing has billing toggle: works}
- [ ] Testimonials stack on mobile
- [ ] Footer complete in all languages
- [ ] Self-contained

After delivery, reply: "Landing page complete. Ready for prompt {N+1}."
```

---

## Appendix E — Transactional Communications Template (Greenfield)

For email/SMS/push templates the product sends programmatically.

```markdown
# Prompt {N} of {M} — Transactional Communications

> Run AFTER prompt {N-1}. Produces ONE file: `{project-slug}-Communications.html` (showcase format with all templates side-by-side).

## Channel-specific design constraints (CRITICAL)

{Pick the channels that apply to this product:}

**For EMAIL templates:**
1. Inline CSS only — `<style>` blocks get stripped by some clients
2. Tables for layout, NOT divs — Outlook uses Word's rendering engine
3. Max width 600px
4. Mobile single-column
5. No background images — many clients block them
6. Web-safe fonts only with fallbacks
7. Buttons via padded `<a>` tags with table wrappers — `<button>` doesn't work in Outlook
8. Plain-text fallback URL displayed below every CTA
9. Dark-mode safe: solid backgrounds + explicit text colors

**For PUSH notifications:**
1. Title under 50 chars
2. Body under 150 chars
3. Optional rich media (icon, image) — design at typical sizes
4. Deep link target

**For SMS templates:**
1. 160 chars per segment — write copy that fits
2. No formatting except line breaks
3. Include short URL pattern if linking
4. Sender ID strategy

## Templates to deliver

| # | Template | Recipient | Trigger | Channel | Branding |
|---|---|---|---|---|---|
{Rows for each template the product needs. Common ones:}
| 1 | Welcome | New user | After sign-up confirmed | Email | {Product} |
| 2 | Email verification | New user | Before verification complete | Email | {Product} |
| 3 | Password reset | User | "Forgot password" | Email | {Product} |
| 4 | Team invite | Invited person | Admin invites | Email | {Product} |
| 5 | {Domain event 1, e.g. order confirmation} | {recipient} | {trigger} | {channel} | {brand} |
| 6 | {Domain event 2} | ... |
| ... | ... |

## Each template specifies

- Subject line (per language, for email)
- Preheader text (for email)
- Body content
- Plain-text fallback URL displayed below every CTA (for email)
- Variable placeholders documented at top using `{{name}}` syntax

## Template content specs

{For each template: exact subject/body, CTA, variables, language variants.}

## Deliverable

**ONE file**: `{project-slug}-Communications.html` — showcase format with all templates rendered side-by-side for design review.

Verification:
- [ ] All templates rendered in the showcase
- {For email: table-based layout, inline CSS, max-width 600px, plain-text fallback per CTA}
- [ ] One clear primary action per template
- [ ] Variable placeholders documented per template
- [ ] {If multi-language: all language variants shown}
- [ ] Customer-facing vs. operator-facing templates use the right branding (per the table)

After delivery, reply: "Communications complete."
```

---

## Appendix F — Onboarding Flow Template (Greenfield)

```markdown
# Prompt {N} of {M} — Onboarding Flow

> Run AFTER prompt {N-1}. Produces ONE file: `{project-slug}-Onboarding.html`

## What it is

First-time setup wizard new users go through after sign-up. {X} steps to get them to their first meaningful moment in the product.

## Visual identity

Distinct from main product chrome — usually no persistent nav, progress indicator at top, focused single-column or two-column layout. Welcoming, encouraging tone.

## Step list

{Adapt to the product. Common shape:}

1. `step-welcome` — greeting + value reinforcement
2. `step-{first-input}` — first big input (name, org info, role, primary intent, etc.)
3. `step-{customize-or-choose}` — pick a preset, theme, or starting configuration
4. `step-{first-action}` — actually do the first meaningful thing (add an item, connect a source, invite a teammate, etc.)
5. `step-{integrations-or-payment}` — connect something downstream, or set up billing
6. `step-success` — congratulations + first CTA into the actual product

## Key step details

{For each step: title, subtitle/copy, form fields or actions, primary CTA, optional "Skip for now" link, validation rules, what happens if user backs out.}

## Translation
{If multi-language.}

## Deliverable

**ONE file**: `{project-slug}-Onboarding.html`

Verification:
- [ ] All steps present, each with `id="step-*"`
- [ ] Progress indicator updates correctly
- [ ] Back / Continue navigation works
- [ ] Skip-for-now on optional steps
- [ ] Final success state designed
- {If multi-language: language toggle works}
- [ ] Mobile responsive
- [ ] Self-contained

After delivery, reply: "Onboarding complete. Ready for prompt {N+1}."
```

---

## Appendix G — Mobile Companion Template (Greenfield, only if requested)

```markdown
# Prompt {N} of {M} — Mobile App Screens

> Run AFTER prompt {N-1}. Produces ONE file: `{project-slug}-Mobile.html` (showcase at mobile frames).

## What it is

{X} screens of the {project} mobile app, designed at native mobile dimensions and shown in iPhone-style frame mockups for design review.

## Visual identity

Mobile-specific brand expression: sticky bottom CTAs, large tap targets, native iOS/Android patterns (sheet modals, swipe-to-action, pull-to-refresh).

## Screen list

{Adapt to the product. Examples:}
1. `screen-onboarding`
2. `screen-home` (with bottom tab bar)
3. `screen-{detail}`
4. `screen-{action}`
5. `screen-profile`
{...}

## Key screen details

{Per-screen: what's on it, what the user does, native patterns used, edge cases.}

## Deliverable

**ONE file**: `{project-slug}-Mobile.html` rendering screens in 375×812 frames side-by-side for review.

Verification:
- [ ] All screens at 375×812 in frame mockups
- [ ] Bottom tab bar consistent across tabbed screens
- [ ] Native input behavior (date picker, sheet modals)
- [ ] Pull-to-refresh / swipe-to-action affordances
- {If multi-language: language toggle + RTL mirror if applicable}

After delivery, reply: "Mobile complete."
```

---

## Appendix H — Update Prompt Template (Update Mode)

This is the template for adding/modifying ONE feature in an existing Claude Design project. Use ALL CAPS section headers — they make the prompt scannable and force hard constraints.

```markdown
# {Feature Name — short and specific, e.g. "Announcement Bar manager", "Audit log filters", "Bulk export modal"}

CONTEXT: This continues the existing {project name} {surface name} design. Keep
the same design system, tokens, spacing, and component style already
established. {2-3 sentences explaining what currently exists, what's missing,
and why users need this. Be specific — name the current behavior that's being
upgraded, e.g. "currently hardcoded in the templates" or "currently not
configurable per role" or "currently a manual CSV export with no preview".}

WHERE: {Exact navigation placement. Which nav section? Which tab? Which modal?
Reference a sibling page for clarity. E.g., "Add a new dedicated page in the
admin, '{Feature}', in the main sidebar nav (place it near {sibling page}).
Use the standard {surface} page shell ({describe: page title, description
line, primary action button}) consistent with the other {surface} pages."}

PAGE LAYOUT: {Structural pattern, ideally referencing an existing page. E.g.,
"two-panel, matching the {sibling page} pattern — Left panel: controls; Right
panel: live preview with X updating in real time." Or "single-column list view
matching the {sibling} pattern." If introducing a new pattern, describe it
explicitly with reasoning.}

{SECTION BREAKDOWN — typically multiple sections. Use ALL CAPS subheaders
matching the layout. Common patterns:

LEFT PANEL — global settings (top):
- {Component name + behavior}
- {Component name + behavior}
- {Cross-references to existing components — "same pattern as the existing
  X controls"}

LEFT PANEL — {detail area} (below settings):
- A list of {entity} rows; "Add {entity}" button at the bottom
- Each row is an editable card with:
  - {Field}: {behavior, validation, helper text}
  - Optional {field}: {when shown, fallback behavior}
  - Optional per-{entity} override (collapsed by default behind a toggle)
  - {Schedule/active toggle/drag handle to reorder/delete (with confirm)} — if applicable
- Status badges per row: {list states}

RIGHT PANEL — live preview:
- Render {the feature} in the mini preview, styled with chosen tokens
- Reflect changes live: {what updates in real time}
- Handle empty state: {what shows when nothing is configured}
{- Render in the currently selected preview language; if RTL, the {component} mirrors} — if multi-language

If the feature is simpler (one section, no panels), describe it as
"SECTIONS (top to bottom):" with each section bulleted, or "FORM FIELDS:" / 
"COMPONENTS:" / etc. as fits.}

RULES (match the rest of the {surface}):
- {If multi-language: Full {language} i18n for all labels and helper text; if RTL is involved, never mix LTR and RTL on one line}
- Use existing design tokens and the existing {input / toggle / color-picker /
  date-picker / segmented-control / badge / modal / etc.} components — no new
  visual language, no hardcoded colors except {user-controllable colors if applicable}
- Empty states: {what shows when there's nothing} → friendly empty state with
  an "{Add your first X}" CTA. A {entity} with blank {required field} is
  treated as incomplete and excluded from {the preview / the list / submissions}
- {Any cross-cutting rule specific to this feature: reordering affects priority,
  scheduling controls visibility, permissions gate visibility, etc.}

OUTPUT: add the new "{Feature Name}" {page/section/modal/component}
({structural summary}) consistent with the existing {surface} file structure,
component usage, and section comments. Do NOT regenerate other pages or
sections — extend the existing file only.
```

## How the OUTPUT clause works (CRITICAL)

The OUTPUT clause is the most important part of an update prompt. It MUST tell Claude Design:

1. **What to add** — the specific page/section/feature
2. **Where to add it** — referencing the existing file/section structure
3. **What NOT to do** — explicitly forbid regenerating other parts

Good OUTPUT phrasings (use whichever fits):
- "add the new X page consistent with the existing {surface} file structure, component usage, and section comments"
- "extend the existing Settings page with the X section — do not modify other settings sections"
- "add X to the header above the existing navbar — keep all other pages unchanged"
- "add the X modal to the {parent page} — do not regenerate the {parent page} itself, just add the new modal markup and the trigger button"

Bad OUTPUT phrasings (avoid):
- "make this work" (too vague)
- "redesign the page with this feature" (invites regeneration)
- "update everything to support X" (scope creep)

## When to use rich section breakdowns vs. tight prose

**Rich breakdown (LEFT PANEL / RIGHT PANEL with bullets per component)**: when the feature is structurally complex — settings + content + preview, multiple states, drag-reorder, scheduling, conditional rules.

**Tight prose (SECTIONS as numbered paragraphs)**: when the feature is a single linear flow or a smaller addition — a new tab, a new modal, a new section in an existing page. Reduces noise.

**Form spec (FIELDS as a list)**: when the feature is purely a form — new settings, a new dialog, an input flow. Just list the fields with their type, default, validation, help text.

## Common pitfalls to avoid (update mode)

- **Don't omit WHERE** — without explicit placement, Claude Design will guess and may put the feature in the wrong shell location.
- **Don't omit the layout reference** — saying "two-panel" without naming a sibling leaves visual quality to chance.
- **Don't invent new components** — if a color picker exists in the project, the update prompt should say "same color picker as in Theme Editor" / "same date picker as in the Schedule page" — not redesign one.
- **Don't forget the OUTPUT clause** — without it, Claude Design defaults to regenerating large chunks.
- **Don't over-specify** — leave room for tasteful micro-decisions. Specify what each component does and contains, not the exact pixel dimensions.
- **Don't write update prompts for greenfield work** — if the user needs more than 1-2 features added, switch to greenfield mode for that surface.

---

## Quality bar (both modes)

A good prompt produces a design that, when generated by Claude Design and dropped into the project, needs zero structural changes — only content swaps (real copy, real data, real images replacing placeholders). If the user has to ask Claude Design to "also add the empty state" or "also add Arabic support" or "also add the error variant" after the fact, the prompt was incomplete.

Both greenfield prompts and update prompts are held to this bar.

## A note on adaptability

This skill works equally well for:
- E-commerce platforms (storefronts + admin + payments)
- B2B SaaS (dashboards + settings + onboarding)
- Marketplaces (browse + transaction + dual-sided dashboards)
- Content platforms (feed + editor + creator dashboard)
- Internal tools (operator UI + admin)
- Mobile apps (mobile screens + companion web)
- Educational products (learner UI + instructor UI)
- Healthcare / finance / regulated products (with audit + compliance surfaces)
- Any other digital product with a UI

The skill never imposes naming conventions, layout patterns, or feature lists from one project onto another. Discovery drives everything.
