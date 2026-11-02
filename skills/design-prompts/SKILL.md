---
name: design-prompts
description: |
  Generates structured design prompts for any digital product (SaaS, e-commerce,
  content, marketplace, mobile, dashboard, marketing site, …) for any design tool
  (Claude Design canvas, code generators such as Claude Code / v0 / Lovable /
  Bolt, or a tool chosen later), in two modes: GREENFIELD (a tool-neutral design
  system, an app map that assembles every screen into one product, and bound
  per-section briefs) and UPDATE (one focused brief that extends an existing
  design without regenerating it). Project-agnostic.

  Trigger when:
  - the user types /design.prompts
  - the user says "generate/create design prompts", "design prompts for
    [project]", "design brief for [project]", "add [feature] to my design", or
    "update my design with [feature]"
  - starting a new design project, or extending an existing one, and a
    comprehensive prompt is needed instead of ad-hoc instructions
  - the user wants to redesign an EXISTING app ("go through every page and
    component and generate design prompts") — read the codebase first

  Do NOT use for: implementing the design in code (use the code-quality family),
  or one-off visual tweaks that don't need a structured prompt.

---

# Design Prompts — Reusable Recipe

This skill writes the design once, in tool-neutral documents, and adds a thin adapter that says how to build it in the chosen tool. Design tools change (standalone Claude Design closes on 2026-12-14 and moves into Claude); when one does, only its adapter changes.

**Two gates come before everything else** ([core-contract](references/core-contract.md) §1):
- **G1: one design system, followed everywhere.** `01-DESIGN.md` is the only source; it is built once in the tool, and every screen uses its components and tokens by name. Sections differ only through approved variants it defines.
- **G2: one assembled design.** Every screen of the product lives in one container (one canvas, project, file or codebase), linked, with shared components reused by reference. No section gets its own container.

**What the skill delivers** ([core-contract](references/core-contract.md) §2): `00-Orientation.md`, `01-DESIGN.md` (design system), `02-APP-MAP.md` (the assembled product + binding, which also builds the app shell), one bound brief per section, a `README.md` and a `VERIFICATION.md`.

**Standards every prompt meets:**
- **Depth** ([depth-standard](references/depth-standard.md)): the minimum detail per screen, weak-vs-strong snippets, length proportions and a self-check.
- **Motion and finish** ([motion-and-finish](references/motion-and-finish.md)): the direction is inferred from the project, written in plain words, and the behaviours are chosen from a catalogue; nothing is left to "smooth" or "modern".
- **Existing app? Inventory the code first** with parallel agents, then delegate brief writing with one shared brief ([codebase-inventory](references/codebase-inventory.md), [writer-brief](references/writer-brief.md)).
- **Verification** ([verification-protocol](references/verification-protocol.md)): the gates are checked after every prompt, and each adapter's own capability is tested separately.

## Adapters (how to build in a tool)

| Tool | Adapter | Status |
|---|---|---|
| Claude Design canvas (Design artifacts in Claude) | [adapter-claude-canvas](references/adapter-claude-canvas.md) | Partly tested 2026-10-14 (shared components, callbacks, links); see its Untested list |
| Code generators (Claude Code, v0, Lovable, Bolt, a plain artifact page, the user's repo) | [adapter-code-generator](references/adapter-code-generator.md) | One-project variant untested |
| Google Stitch, Figma, others | none yet | Not shipped until tested ([verification-protocol](references/verification-protocol.md) §2) |
| Not sure yet | core documents only | Assembly pending: the README says the set still needs an adapter |

Tell the user the status in plain words before they pick, and recommend a tool whose adapter can pass both gates for their constraints.

## Two modes

### GREENFIELD MODE
**When**: starting a new design project, or restarting one because earlier results were inconsistent or scattered.
**Output**: the full prompt set above.

### UPDATE MODE
**When**: a design already exists in a container, and the user wants to add or modify ONE feature without regenerating the rest.
**Output**: one focused brief in `updates/`, plus a scoped amendment to `01-DESIGN.md` or `02-APP-MAP.md` only when the feature needs one ([core-contract](references/core-contract.md) §7).

## Mode detection (do this FIRST)

- New project, restart, full system → **Greenfield**
- Add/update/modify/extend an existing design, one page or feature, "just this part" → **Update**
- Unclear: "Is this a new project from scratch, or adding a feature to an existing design? I write different kinds of prompts for each."

---

## When NOT to use this skill

- The user wants you to GENERATE the design itself (not write prompts for a design tool)
- The user has a single-line design need (just write it directly)
- The user wants to debug or critique an existing design (use design review tools instead)
- The user just wants UI copy or icon suggestions (these don't need a structured prompt)

---

# GREENFIELD MODE — Process

Execute these phases in order. The user's input drives every decision; do not invent screens, features or design choices they didn't ask for.

## Phase 0: Codebase inventory (existing apps only)

If the product already exists in a repo (or the user says "go through every page"), run Steps 1-2 of [codebase-inventory](references/codebase-inventory.md) BEFORE Discovery: enumerate every route, read the project's CLAUDE.md / AGENTS.md / DESIGN.md / design docs, and fan out parallel inventory agents (≈10-30 pages each + one design-system agent) that write per-page inventories to the scratchpad. Then return to Discovery and plan confirmation; Steps 3-6 of that reference belong to Phases 3-5. Discovery shrinks to what code cannot answer.

**Ask for a known-good reference**: "Do you have a previous design output you were happy with, in any tool? Give me the link or folder and the prompts that produced it." Record it in the README ("Reference").

## Phase 1: Discovery

**Use the host's structured question tool** (`AskUserQuestion` in Claude Code, `ask_user_input_v0` in claude.ai) for tap answers; batch up to 4 questions per call. Ask in plain words: the user may not be a designer. Required inputs:

### 1. Project basics
- **Project name**, **what the product is** (2-3 sentences: what it does, who the customer is, what problem it solves), **product category** (SaaS app, e-commerce, marketplace, content/media, social, internal tool, B2B platform, consumer mobile app, developer tool, education, healthcare, finance, other).

### 2. Audience and market
- **Target users** (who, their context, technical comfort) and **geographic/cultural context**.

### 3. Areas of the product
Ask which areas the product has. These become **sections of one app** unless they are a separate deployment (core-contract.md §3):
- Primary application area (storefront, dashboard, feed, editor, console…)
- Administrative area (settings/management)
- Platform-operator area (super-admin / internal ops, for multi-tenant products)
- Authentication / onboarding flows
- Help center / documentation
- Public/shared views (read-only profile, share link, embed)
- Separate deliverables that still share the design system: marketing/landing site, transactional communications (email, push, SMS), mobile companion app
- Other (let user specify)

### 4. Variants
- Does any area need different treatments (dense operator tables, a bolder marketing look, user-selectable themes)? These become **approved variants** in `01-DESIGN.md`, never per-section looks.

### 5. Languages and locale
- **Primary language**, **additional languages** (and whether any are RTL: Arabic, Hebrew, Persian, Urdu…), **locale** (currencies, date, number and address formats).

### 6. Visual identity
- **Brand colors** (if known; otherwise propose a palette from the product category and ask for approval)
- **Typography preference** in plain words (modern and clean / classic and editorial / technical / playful)
- **Feel** in plain words (calm and serious / warm and friendly / bold and lively / premium and minimal)
- **Density** (roomy vs packed with information)
- Do NOT ask for motion levels or finishes. Infer them ([motion-and-finish](references/motion-and-finish.md) §0) and show them in the Phase 2 plan.

### 7. Tool
- **"Which tool will you build the design in?"** Claude Design (in Claude) / a code generator or your own repo / another tool / not sure yet. Show the adapter status table above in plain words. Another tool without an adapter, or not sure: deliver the core documents and say assembly is pending.

### 8. Known gaps / required screens
- Pre-identified screens, states or features to cover. Ask about: forgot password, error screens (404/500), empty states, loading states, success states, print views, phone layouts.

### 9. Constraints
- Existing component library or design system (Material, Fluent, Carbon, shadcn, in-house): its conventions are followed; items its brand contract marks LOCKED stay locked.
- Accessibility requirements (WCAG AA, AAA, internal standards)
- Environment and performance (low-bandwidth markets, offline-first, VDI or kiosks, old devices)

If the user can't answer some questions, propose defaults from the evidence and mark them as defaults.

## Phase 2: Plan the set

Decide the app map first ([core-contract](references/core-contract.md) §3): one product, its sections, layouts, every screen key, shared components and their owners, shared journeys, and which prompt builds which section. Then the run order:

| # | Prompt | Always? |
|---|---|---|
| 00 | Orientation | YES |
| 01 | Design system (`01-DESIGN.md`) | YES |
| 02 | App map and shell (`02-APP-MAP.md`): builds the shells, navigation and a placeholder for every screen key in the one container | YES |
| 03-N | One bound brief per section (or per batch of small sections) | Project-dependent |
| Next | Separate deliverables (marketing site, communications, mobile companion), each on the same design system | If applicable |

**Split rule:** a section with more than ~15-18 screens, or with one giant tool (calendar/scheduler, multi-step sales wizard), becomes part 1 + part 2 into the same container ([split-surface-template](references/split-surface-template.md)).

**Brief the user on the plan before writing**, in plain words, including the inferred direction and the tool's gate status. Example:
> "Plan: one app called BookFlow, built in one Claude Design canvas. 00 Orientation, 01 Design system (calm and quick, flat with light borders, because staff use it all day), 02 App map with every screen linked, then 03 Bookings, 04 Members, 05 Settings. The marketing site is prompt 06 on the same design system. The canvas adapter is partly tested: shared components and links work; editing a shared component everywhere at once hasn't been tested yet. Sound right?"

Adjust based on their answer. Don't write until they confirm.

## Phase 3: Write 00, 01 and 02

- **00 Orientation**: Appendix A.
- **01 Design system**: [design-system-template](references/design-system-template.md), with the adapter header.
- **02 App map and shell**: [core-contract](references/core-contract.md) §3 (skeleton included), with the adapter header and the adapter's instructions for building the shells, navigation and placeholders in the one container the user opened at 00 (core-contract §2).

## Phase 4: Write the section briefs

For each section, start from the matching appendix for its page-content guidance, then fill it from Discovery or the inventory:

- **Primary application area**: Appendix B
- **Administrative / management area**: Appendix C
- **Marketing / landing site**: Appendix D
- **Transactional communications** (email, push, SMS): Appendix E
- **Onboarding / setup wizard**: Appendix F
- **Mobile companion**: Appendix G

These appendices are SKELETONS. Adapt them to the product. Don't include sections that don't apply.

For big sets (≈6+ section prompts), write 00-02 yourself, then write a shared `WRITER-BRIEF.md` ([writer-brief](references/writer-brief.md)) and fan out writer agents (1-3 prompts each) pointed at the brief, 00-02, the adapter and their inventory. Then run the set checks in [codebase-inventory](references/codebase-inventory.md) Step 5 and [verification-protocol](references/verification-protocol.md) §3 yourself.

Each section brief MUST contain:
1. Header: "Prompt N of M — [Section]" + the adapter header + "Run AFTER prompt N-1"
2. **Binding** block ([core-contract](references/core-contract.md) §4): container, design system, owned screen keys, extends, links out, shared components used and created, do not touch
3. Recap: task context in 3-5 lines (product, this section's users and jobs); no design-system values
4. Section identity: who, jobs, and which approved variant applies (or "default")
5. Files or artboards to deliver, per the adapter
6. Complete screen list as screen keys (incl. 404 / no access / error if the map assigns them here)
7. Key screen details for EVERY screen, meeting [depth-standard](references/depth-standard.md); design the intended behaviour, not bugs found in the code
8. Mock data (realistic for the market, sized to look real)
9. Translation glossary specific to this section's voice (only if multi-language)
10. Visual + UX requirements, and **Motion**: the behaviours `01-DESIGN.md` selected, named per component type, with any section-specific exception and its reason
11. **Proposals (not to build yet)**
12. Deliverable: the adapter's verification lines plus the G1/G2 checks from [verification-protocol](references/verification-protocol.md) §1
13. Handshake: "After delivery, reply: '[X] complete. Ready for prompt N+1.'"

## Phase 5: Save and deliver

Before saving, run the self-checks in [depth-standard](references/depth-standard.md) §4, [motion-and-finish](references/motion-and-finish.md) §6 and [verification-protocol](references/verification-protocol.md) §3 on every prompt (including ones written by delegated agents) and fix anything that fails.

In Claude Code, save to `docs/design-prompts/` (or where the user says); in claude.ai, save to `/mnt/user-data/outputs/<project-slug>-design-prompts/` and call `present_files`. The `README.md` has: how to run · tool, adapter and its tested status · prompt/section/language table · design direction · gate status · Decisions for the PO (every proposal and behaviour change, grouped) · assets to upload (self-hosted fonts, logos the tool cannot fetch). Add an empty `VERIFICATION.md` with the table from [verification-protocol](references/verification-protocol.md) §1.

End with usage instructions:
> "Open one new {container} and paste 00 first, then 01, 02 and the rest in order, all into that same {container}. As soon as your tool shows the {container}'s link, write it into the Binding blocks. After each prompt, tick that phase's checks in VERIFICATION.md before running the next."

**No adapter (tool not chosen, or a tool without one):** deliver the documents as a plan only. The README says plainly that they are not ready to paste: an adapter has to be chosen (or written and tested) and the adapter headers and Binding blocks filled in first. Do not give the paste instructions above.

---

# UPDATE MODE — Process

Use this when the user wants to add or modify ONE feature in an existing design. The output is one focused brief, not a new set.

## Phase 1: Update Discovery

1. **Which product, which container, which section?** Ask for `01-DESIGN.md` and `02-APP-MAP.md`. If they don't exist, establish before writing anything: the container (its link or path), where the design system lives and its version or date, the existing screen keys around the feature, and which section owns them. Read them from the container or the user's files; ask for what you cannot read. **Do not write the update until all four are known.** If the design has no shared design system or is split across containers, say so: the update would deepen the problem, so propose fixing that first (a greenfield 01 and 02 for the existing design).
2. **What's being added/changed?** Feature name + 2-sentence purpose
3. **Why now / what's the gap?** What exists vs. what's missing
4. **Where does it go?** Nav placement, parent screen, screen key
5. **Layout to match**: an existing screen whose structure this should follow
6. **Components needed**: which existing design-system and shared components are reused. Avoid inventing new visual language.
7. **States required**: empty, loading, error, success, edit-in-place, locked, disabled…
8. **Cross-cutting rules**: language coverage, validation, scheduling, permissions, dismissibility
9. **Interactivity**: live preview, drag-to-reorder, cycling content, optimistic updates

If the user already wrote a draft of the feature, parse it and only ask about gaps.

## Phase 2: Confirm scope

> "Writing one update prompt for: **[Feature]** added to **[Section]** in **[container]**, placed at **[Location]**, using the **[Pattern]** layout, with **[Key states]**, on the existing design system. Ready to write?"

## Phase 3: Write the update prompt

Use **Appendix H**. Its ALL CAPS section headers make the prompt scannable and make each section a hard constraint. The OUTPUT clause is the most important part: it tells the tool to add ONLY this feature, in the existing container, without regenerating anything else.

## Phase 4: Save and deliver

In Claude Code, save next to the set (`docs/design-prompts/updates/<feature-slug>.md`, or where the user says); in claude.ai, save to `/mnt/user-data/outputs/<project-slug>-update-prompts/<feature-slug>.md` and call `present_files`. A scoped amendment to `01-DESIGN.md` or `02-APP-MAP.md` is saved beside it and applied to the documents.

End with:
> "Paste this into the same {container} where the design lives. It adds just this feature."

---

## Critical rules — apply to BOTH modes

1. **Self-contained in task, never in design system.** Every prompt repeats the task context it needs, so it works pasted alone. It references the design system by component and token name and never restates its values ([core-contract](references/core-contract.md) §5).

2. **Every prompt bounds its output**: what it adds, where (the Binding), and "do not regenerate or restyle anything not listed".

3. **Every prompt names its output exactly**: files or artboards per the adapter, derived from the project name and screen keys. No placeholders like `[filename]` in the final prompt.

4. **G1 and G2 are never traded away.** No section gets its own container, its own copy of a shared component, or its own visual tone. If the chosen tool cannot pass a gate, say so in the README instead of working around it.

5. **Every multi-language section includes a translation glossary** in its voice. Skip it for monolingual products.

6. **Greenfield prompts end with a handshake** naming the next prompt. Update prompts are standalone.

7. **The user's input drives everything.** Do not invent sections, features or layouts they didn't ask for. Do not skip what they did ask for.

8. **Push back if the brief is incomplete.** If the user says "make me a prompt" with no context, ask Discovery questions first. Generic prompts produce generic designs.

9. **Project naming carries through** to containers, files and screen keys. The skill never imposes naming conventions from other projects.

10. **Templates are skeletons.** Adapt the appendices; don't copy them verbatim.

11. **Design intended behaviour, not bugs.** When prompts come from a code inventory, bugs (wrong timezone, mislabelled status, hover-only actions, browser `prompt()` boxes) become requirements for the correct version. Report the bugs to the user separately.

12. **Proposals stay pending.** Anything new (a feature, a font, a renamed nav item, a behaviour-changing gesture) goes under the brief's Proposals and the README's Decisions for the PO, and is not built until approved ([core-contract](references/core-contract.md) §6).

13. **Respect the brand contract.** If the repo has a DESIGN.md / brand doc with LOCKED items, keep them and modernise how they are used; changes to locked items are proposals. An existing design system's conventions are followed, not overridden.

14. **When the output deviates from the prompt, diagnose before you edit.** Don't change the prompts on the first bad result:
    1. **Get a baseline**: the user's known-good reference if there is one; otherwise the adapter's documented format and tested behaviour.
    2. Compare the failing prompt with the baseline (header, Binding, format lines).
    3. Compare the bad output with the baseline output or the adapter's documented format.
    4. If the prompt already matches, treat the tool or project setup as a **hypothesis**, not a finding: ask the user how the project was created and what the tool reported, and recommend a change only after that check confirms a cause.
    5. Only when the prompt differs from the baseline, change it, and only by moving it toward the baseline and the gates.
    Never add "forbid X" locks or retarget the format based on one run. (In the 2026-09-30 AppCMS incident, both of those fixes were wrong and cost the user two rounds.)

15. **Specify motion and finish, never assume them.** Every prompt names the behaviours its components use from the catalogue chosen in `01-DESIGN.md` ([motion-and-finish](references/motion-and-finish.md)). "Smooth", "modern", "animated" or "nice transitions" on their own are not specifications. Components the product doesn't have get no motion lines.

---

## Appendix A — Orientation Template (prompt 00)

```markdown
# {PROJECT_NAME} — Orientation

> {Adapter header.} Paste this as the FIRST message in a new {container}. It sets context for every
> later prompt. Do not generate any design yet.

## About {PROJECT_NAME}
{1-2 paragraphs: what the product is, who uses it, its category.}

## How this design is built
- One product, one {container}: every screen goes into this {container}, linked. Never start another one.
- One design system: prompt 01 builds it once; every screen uses its components and tokens by name and only its approved variants.
- Prompt 02 creates the app map: shells, navigation and a placeholder for every screen. Later prompts replace placeholders; they never add loose screens or copy shared components.
- Anything under "Proposals (not to build yet)" in a prompt is NOT built.

## Voice and tone
{One consistent voice, or per-section voices if they differ (marketing persuasive, admin calm).}

## Language rules
{Only if multi-language. Otherwise omit entirely.}
1. Every visible string comes from the translation mechanism the adapter names (e.g. `t('key')`); no hard-coded copy
2. The language switch updates `lang` and `dir` on the root
3. Every key exists in every locale
{If any language is RTL:}
4. CSS uses logical properties throughout: `padding-inline-start`, `margin-inline-end`, `inset-inline-start`, `text-align: start`; never `left`/`right`
5. Numbers, currency, dates, IDs and code stay LTR (`dir="ltr"` spans) inside RTL content
6. Never mix LTR and RTL text on the same line

## Tool rules
{From the adapter: format, file or artboard naming, how screens link, how shared components are mounted or imported, what to deliver per prompt.}

## Verification standard
Every prompt's output must pass:
- [ ] It landed in this {container}; nothing new was created elsewhere
- [ ] Only design-system components and tokens; only approved variants; STATUS map tones
- [ ] Every screen it owns is reachable, and links into and out of it work
- [ ] Shared components are reused, not re-created
- [ ] Responsive at 375px; reduced motion honoured (only colour and opacity animate)
- {If multi-language:} [ ] Language switch changes every string; {If RTL:} RTL mirrors, logical CSS, numbers LTR

## Confirming you're oriented
Reply with: "Oriented. Ready for prompt 01 (design system)."
```

---

> **Appendices B-G give the page-content guidance per kind of section.** Every one is written as a bound section brief: it carries the header, Binding block and the 13 items from Phase 4; screens are screen keys from `02-APP-MAP.md`; files or artboards follow the adapter. Separate deliverables (D, E, G) still use `01-DESIGN.md` and are listed in the app map.

## Appendix B — Primary Application Section

The "primary application section" is the main user-facing experience: the storefront for e-commerce, the dashboard for SaaS, the feed or reader for content, the browse + transaction area for a marketplace. **Adapt this template to the project.**

```markdown
# Prompt {N} of {M} — {Section Name}

> {Adapter header.} Run AFTER prompt {N-1}.

## Binding
{core-contract.md §4}

## Recap
{3-5 lines of task context.}

## Section identity
{What the user does here, their main tasks, and which approved variant applies (or "default").}

**Translation tone** (if multi-language): {formal / casual / persuasive / …}

## Complete screen list
{Group screens by the user's mental model. ADAPT TO THE PROJECT:

### Entry / discovery
- `home` or `feed` — {what users see first}
- `search` or `browse` — {discovery}

### Detail / depth
- `detail` or `item` or `profile` — {single-item view}

### Action flows
- `create` or `checkout` or `book` — {primary action flow}
- `confirm` — {post-action confirmation}

### Account
- `account` — {user's own data}

### Auth (if hosted in this section)
- `signin`, `signup`, `forgot-password`, `reset-password`

### Utility
- `404`, `empty-result`, {print/share/export views if applicable}
}

## Key screen details
{For EVERY screen, per depth-standard.md: purpose, sections top to bottom with real data, actions with target screen keys, overlays with fields and validation, states (loading, empty, error, success + domain states), phone behaviour.}

## Mock data
## Translation glossary
{Only if multi-language: ~20-40 phrases in this section's voice, grouped by navigation, status terms, actions, content labels.}

## Visual and UX requirements
## Motion
## Proposals (not to build yet)

## Deliverable
{Adapter files or artboards; adapter verification lines; G1/G2 checks; section-specific checks such as search interactions, drag-and-drop, infinite scroll.}

After delivery, reply: "{Section} complete. Ready for prompt {N+1} ({next})."
```

---

## Appendix C — Administrative / Management Section

For management dashboards, admin panels, settings consoles, operator areas.

```markdown
# Prompt {N} of {M} — {Section Name}

> {Adapter header.} Run AFTER prompt {N-1}.

## Binding
## Recap

## Section identity
{Who manages what here; multi-tenant or single-org; self-service or operator-led. Usually the `dense` approved variant if 01-DESIGN.md defines one: same brand, more compact, more data display.}

## Complete screen list

### Shell
{The shell is created by prompt 02. List only what this section adds to it (nav items already exist as placeholders), e.g. a command palette or a notification panel if the map assigns it here.}

### Main screens
- `dashboard` — {KPIs, summary, recent activity}
- `{entity}-list` — {list of the entity this section manages}
- `{entity}-detail` — {single entity view/edit}
- `{settings-area}` — {grouped settings}

### Auxiliary screens (auth-style layout, if the map assigns them here)
- `signin`, `forgot-password`, `reset-password`, `accept-invite`, `404`, `500`, `empty-workspace`

## Key screen details
{Per screen, be explicit about:}
- Tables/lists: columns, filters, sort, pagination, bulk actions, row actions
- Detail/edit: sections, form fields, validation, save/discard pattern
- Empty states: what's shown with zero data
- Permission-gated UI: hidden vs. disabled per role

## Mock data / Translation glossary / Visual and UX requirements / Motion / Proposals (not to build yet)

## Deliverable
{Adapter files or artboards; adapter verification lines; G1/G2 checks; every auxiliary screen with its states; empty workspace designed; phone at 375px.}

After delivery, reply: "{Section} complete. Ready for prompt {N+1}."
```

---

## Appendix D — Marketing / Landing Site

A separate deliverable (often a separate deployment) on the same design system, using its `marketing` approved variant if one exists: more visual, display typography, more imagery and whitespace, same tokens.

```markdown
# Prompt {N} of {M} — Marketing Landing Site

> {Adapter header.} Run AFTER prompt {N-1}. Builds in the same {container} as the app, as its own
> screens, so the shared design system and links into sign-up stay connected.

## Binding
## Recap

## Section list (top to bottom; omit what doesn't fit the product)
1. **Navbar** — logo, nav links, sign-in link, primary CTA (links to the app's `signup` screen key)
2. **Hero** — headline (6-10 words), subheadline (1-2 sentences), 2 CTAs, hero visual, trust strip
3. **Social proof** — customer logos, key stats, testimonial snippet
4. **How it works / features** — 3-6 steps or feature cards
5. **Differentiation** — the unique value vs. alternatives
6. **Deep-dive** — product screenshots, embedded video, interactive demo
7. **Pricing** — tiers, billing toggle if applicable, comparison table, sales contact
8. **Testimonials / case studies** — quotes with attribution
9. **FAQ** — accordion
10. **Final CTA**
11. **Footer** — product/resources/company/legal/social links

## Key section details
- Hero: exact headline + subheadline copy (if the user knows it)
- Pricing: tiers, what's in each, billing options
- Testimonials: real names, or placeholders marked [REAL TESTIMONIAL]

## Translation / Visual and UX requirements / Motion / Proposals (not to build yet)

## Deliverable
- Hero above the fold at 1440px and 375px; all sections present; primary vs secondary CTAs distinct; billing toggle works (if any); testimonials stack on phones; footer complete in all languages; G1/G2 checks.

After delivery, reply: "Landing site complete. Ready for prompt {N+1}."
```

---

## Appendix E — Transactional Communications

Email, push and SMS templates the product sends. A separate deliverable on the same design system: tokens and voice are reused, but motion is `none` (many email clients don't run CSS animation; SMS has no visuals).

```markdown
# Prompt {N} of {M} — Transactional Communications

> {Adapter header.} Run AFTER prompt {N-1}. Builds a review board of every template in the same
> {container}, so they are checked against the app's design system.

## Binding
## Recap

## Channel constraints (CRITICAL)

**EMAIL:**
1. Inline CSS only (some clients strip `<style>` blocks)
2. Tables for layout, not divs (Outlook uses Word's rendering engine)
3. Max width 600px; single column on phones
4. No background images; web-safe fonts with fallbacks
5. Buttons as padded `<a>` tags inside table cells (`<button>` doesn't work in Outlook)
6. A plain-text fallback URL below every CTA
7. Dark-mode safe: solid backgrounds and explicit text colours
8. No animation

**PUSH:** title under 50 characters, body under 150, optional icon/image at typical sizes, deep link target (a screen key).

**SMS:** 160 characters per segment, no formatting except line breaks, short URL pattern, sender ID strategy.

## Templates

| # | Template | Recipient | Trigger | Channel | Branding |
|---|---|---|---|---|---|
| 1 | Welcome | New user | Sign-up confirmed | Email | {Product} |
| 2 | Email verification | New user | Before verification | Email | {Product} |
| 3 | Password reset | User | "Forgot password" | Email | {Product} |
| 4 | Team invite | Invitee | Admin invites | Email | {Product} |
| 5 | {Domain event} | {recipient} | {trigger} | {channel} | {brand} |

## Each template specifies
- Subject line and preheader (email, per language), body, CTA with its target screen key, plain-text fallback URL, variables documented with `{{name}}` syntax

## Deliverable
- Every template on the review board; email rules above followed; one clear primary action per template; variables documented; all language variants; customer-facing vs. operator-facing branding per the table; G1 checks.

After delivery, reply: "Communications complete."
```

---

## Appendix F — Onboarding Flow

```markdown
# Prompt {N} of {M} — Onboarding Flow

> {Adapter header.} Run AFTER prompt {N-1}.

## Binding
{Usually a shared journey: the steps carry data from one to the next, so the adapter decides how state is held (e.g. one artboard on a canvas, the shared store in code).}

## Recap

## Section identity
First-time setup after sign-up: {X} steps to the first meaningful moment. Uses the auth/full-screen layout from 02 (no persistent nav, progress indicator at top). Welcoming, encouraging tone.

## Step list
{Adapt to the product:}
1. `onboarding-welcome` — greeting + value reinforcement
2. `onboarding-{first-input}` — first big input (name, org, role, intent)
3. `onboarding-{customize}` — pick a preset, theme or starting configuration
4. `onboarding-{first-action}` — do the first meaningful thing
5. `onboarding-{connect}` — integrations or billing
6. `onboarding-success` — congratulations + CTA into the product (links to its first screen key)

## Key step details
{Per step: title, copy, fields or actions, primary CTA, optional "Skip for now", validation, what happens on Back.}

## Translation / Visual and UX requirements / Motion / Proposals (not to build yet)

## Deliverable
- Every step present; progress indicator updates; Back / Continue work and keep entered data; skip on optional steps; success state; language switch; phone layout; G1/G2 checks.

After delivery, reply: "Onboarding complete. Ready for prompt {N+1}."
```

---

## Appendix G — Mobile Companion (only if requested)

A separate deliverable on the same design system, built in the same container as phone-sized screens.

```markdown
# Prompt {N} of {M} — Mobile App Screens

> {Adapter header.} Run AFTER prompt {N-1}. Phone screens at 390×844 in the same {container}.

## Binding
## Recap

## Section identity
Mobile-specific expression of the same design system: sticky bottom CTAs, large tap targets, native patterns (sheet modals, swipe actions, pull-to-refresh). Behaviour-changing gestures go under Proposals until approved.

## Screen list
1. `m-onboarding`
2. `m-home` (with bottom tab bar)
3. `m-{detail}`
4. `m-{action}`
5. `m-profile`

## Key screen details
{Per screen: what's on it, what the user does, native patterns used, edge cases.}

## Deliverable
- Every screen at 390×844; bottom tab bar consistent across tabbed screens and links between tabs work; native input behaviour (date picker, sheets); language switch and RTL mirror if applicable; G1/G2 checks.

After delivery, reply: "Mobile complete."
```

---

## Appendix H — Update Prompt Template (Update Mode)

The template for adding/modifying ONE feature in an existing design. ALL CAPS section headers make the prompt scannable and set hard constraints.

```markdown
# {Feature Name — short and specific, e.g. "Announcement Bar manager", "Audit log filters"}

> {Adapter header for the existing container.}

CONTEXT: This continues the existing {project} design in {container}, section {section}. Keep the
same design system, tokens, spacing and component style already established. {2-3 sentences: what
exists now, what's missing and why users need it. Name the current behaviour being upgraded.}

BINDING: {container + link or path} · design system {where it lives in the tool + name/version} · this
update owns screen key(s) {keys} · links to {keys} · shared components used {name (owner)} · do not touch
anything else.

WHERE: {Exact placement: nav section, tab or modal, near which sibling screen. "Use the standard
{section} screen shell (title, description line, primary action) like the other {section} screens."}

PAGE LAYOUT: {Structure, ideally referencing an existing screen: "two-panel, matching {sibling}:
left controls, right live preview updating in real time." A new pattern is described with reasons.}

{SECTION BREAKDOWN — ALL CAPS subheaders matching the layout, e.g.:

LEFT PANEL — global settings:
- {Component + behaviour; "same pattern as the existing X controls"}

LEFT PANEL — {detail area}:
- A list of {entity} rows; "Add {entity}" at the bottom
- Each row is an editable card with: {field}: {behaviour, validation, helper text}; optional
  {field}; schedule / active toggle / drag handle / delete with confirm, if applicable
- Status badges per row from the STATUS map: {states}

RIGHT PANEL — live preview:
- Render {the feature} with the design-system tokens; reflect changes live; empty state;
  {if multi-language: current preview language, RTL mirrors}

Simpler features use "SECTIONS (top to bottom):", "FORM FIELDS:" or "COMPONENTS:" instead.}

MOTION (match the rest of the {section}):
- {Per component, the behaviour 01-DESIGN.md already selected, by name: e.g. "Tabs: the existing
  sliding indicator; content cross-fades with a 6px shift"; "Delete: the existing ConfirmDialog;
  the removed row collapses its height"}
- The applicable interaction states on every new control (motion-and-finish.md §1)
- Use the existing motion and elevation tokens. If the design system has none for something this
  feature needs, add only the feature-scoped tokens as a scoped amendment to 01-DESIGN.md (listed in
  OUTPUT); never hard-code durations, easings or shadows in components
- Reduced motion: only colour and opacity animate

RULES (match the rest of the {section}):
- {If multi-language: full i18n for all labels and helper text; never mix LTR and RTL on one line}
- Use the existing design-system components ({input / toggle / colour picker / date picker /
  segmented control / badge / modal …}): no new visual language, no hard-coded colours except
  user-controllable ones
- Empty states: {what shows} → friendly empty state with an "{Add your first X}" CTA
- {Feature-specific rules: reordering sets priority, scheduling controls visibility, permissions}

PROPOSALS (not to build yet): {anything new the feature could add, for PO approval}

OUTPUT: add the new "{Feature}" {screen/section/modal} to the existing {container}, consistent
with the existing {section} structure and components. Do NOT regenerate or restyle other screens or
files — extend only what is listed.
```

## How the OUTPUT clause works (CRITICAL)

List, per the adapter, each item that applies and omit the rest:
1. **Existing files or artboards to edit**: which one, the component or region inside it, and the exact change (e.g. "`sections/settings/pages-settings-1.jsx`, `SettingsPage`: add a Notifications section after Security")
2. **New files or artboards**, only if the feature needs them
3. **Registration**: for code, the route and nav entries and whatever the project's entry needs to load the new files (the insertion comments in the preview variant, imports in a real stack); for a canvas, the new artboard (or journey state) and its links
4. **Data and every locale**: the appended data and keys
5. **Scoped amendments** to `01-DESIGN.md` or `02-APP-MAP.md`, if any
6. "Do not regenerate or restyle any other file or screen."

The OUTPUT clause MUST tell the tool:
1. **What to add**: the specific screen/section/feature
2. **Where to add it**: in the existing container, referencing the existing structure
3. **What NOT to do**: regenerate other parts

Good OUTPUT phrasings:
- "add the new X screen to the existing {container}, consistent with the {section} structure and components"
- "extend the existing Settings screen with the X section — do not modify other settings sections"
- "add the X modal to the {parent screen} — do not regenerate the {parent screen}, just add the modal and its trigger"

Bad OUTPUT phrasings:
- "make this work" (too vague)
- "redesign the page with this feature" (invites regeneration)
- "update everything to support X" (scope creep)

## When to use rich section breakdowns vs. tight prose

**Rich breakdown** (LEFT PANEL / RIGHT PANEL with bullets): structurally complex features — settings + content + preview, multiple states, drag-reorder, scheduling, conditional rules.

**Tight prose** (SECTIONS as numbered paragraphs): a single linear flow or a small addition — a new tab, modal or section.

**Form spec** (FIELDS as a list): purely a form — list the fields with type, default, validation and help text.

## Common pitfalls to avoid (update mode)

- **Don't omit WHERE or BINDING**: without them the tool guesses, and may put the feature in a new place or a new container.
- **Don't omit the layout reference**: "two-panel" without a sibling leaves quality to chance.
- **Don't invent new components**: "same colour picker as in Theme Editor", not a new one.
- **Don't forget the OUTPUT clause**: without it, tools default to regenerating large chunks.
- **Don't over-specify**: say what each component does and contains, not pixel dimensions.
- **Don't write update prompts for greenfield work**: more than 1-2 features for a section → plan that section's next prompt (part 2 or a new section brief) in the same container, not a fresh design.

---

## Quality bar (both modes)

A good prompt produces a design that drops into the container needing zero structural changes — only content swaps (real copy, data, images). If the user has to ask the tool to "also add the empty state", "also add Arabic", "also add the error variant", "make these screens link", or "use the same button as the other section", the prompt was incomplete.

The bar includes how it feels. If the result doesn't match the direction recorded in `01-DESIGN.md` (missing interaction states anywhere; or, where the direction selected them, an active state that jumps inside its component, panels that snap, a finish flatter than chosen), the prompt was incomplete in the same way as a missing empty state.

## A note on adaptability

This skill works for e-commerce, B2B SaaS, marketplaces, content platforms, internal tools, mobile apps, education, regulated products (healthcare, finance) and any other digital product with a UI, in any tool with an adapter. It never imposes naming conventions, layouts or features from one project onto another. Discovery drives everything.

## What this skill does not do

- Generate the design itself — it writes the **prompts** you feed to a design tool, not the screens.
- Implement the design in code — that's the code-quality family; `ship-ticket` reads the resulting design set as its source of truth.
- Impose one project's conventions on another.
- Handle a one-off visual tweak that doesn't need a structured prompt.

## Success criteria

Working when: greenfield mode yields a numbered, scope-bounded set whose output, in the chosen tool, passes G1 and G2 and needs only content swaps; and update mode changes exactly one feature in the existing container without regenerating its siblings.

## Troubleshooting

- **Screens came back as separate projects, folders or canvases:** the prompts lacked the adapter header or Binding, or the set had no `02-APP-MAP.md`. Re-run the affected prompts with both, naming the existing container ([core-contract](references/core-contract.md) §4).
- **A shared component exists twice:** the second brief listed it as new instead of under "Shared components used". Fix the binding and write one update prompt that replaces the copy with a reference to the owner's.
- **Sections look like different products:** a brief restated or invented design-system values, or used a variant `01-DESIGN.md` doesn't define. Rewrite it to use names only.
- **The tool used a different format than the prompts asked for:** run rule 14. On the Claude canvas, `.dc.html` artboards are the native format ([adapter-claude-canvas](references/adapter-claude-canvas.md)).
- **The tool regenerates too much:** the prompt is missing its OUTPUT clause; bound the scope explicitly.
- **The feature lands in the wrong place:** the prompt omitted WHERE; name the location and a sibling screen.
- **A 25-screen section came back thin or truncated:** split it into part 1 + part 2 ([split-surface-template](references/split-surface-template.md)).
- **Designs miss real fields, modals or states of an existing app:** the prompts were written from route names; run the codebase inventory first.
- **The same screen appears in two sections:** keep it where it shares components (e.g. all payment outcomes in Checkout); the other section links to it by screen key.
- **Designs are complete but look flat, static or dated** (highlights jump inside a component, panels snap, one hard shadow, nothing reacts on hover): `01-DESIGN.md` has no direction or selected behaviours, or briefs don't name them. Re-check the inferred direction ([motion-and-finish](references/motion-and-finish.md) §0); for an existing design, one update prompt per section applies only the motion and finish layer and changes nothing else.
- **Arabic (or brand) typography looks wrong:** a self-hosted font wasn't uploaded to the tool; list required uploads in the README.
