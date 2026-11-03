# Motion and finish: a catalogue to choose from, not one look for everything

Complete content is half of a good result; how screens move and how they look at rest is the other half. Prompts that said only "modern" or "smooth" came back flat, and naming the exact behaviours produced the polished result. That does not mean every product gets the same glow and gradients. `01-DESIGN.md` records the direction chosen for this project and the behaviours selected from this catalogue; section briefs name which ones their components use.

The snippets use a made-up product only to show the level of detail. Never copy their content into a real project.

## 0. Infer the direction from the project (do not ask designer questions)

The user does not need design vocabulary. Infer motion and finish separately, from evidence, in this order:

1. **The project's existing design system or brand doc** (Phase 0 inventory, Discovery constraints): Material, Fluent, Carbon, shadcn or an in-house system. Follow its motion and elevation conventions; fill only what it leaves open. Items its brand contract marks LOCKED stay locked.
2. **Task and density**: all-day data work and operator tools want quick, quiet feedback; onboarding, marketing and consumer flows can carry more expression.
3. **Audience and environment**: accessibility target (AA/AAA), constrained machines (VDI, kiosks, low-end phones), distraction-sensitive work (clinical, trading, monitoring) push toward calmer motion and no decorative effects.
4. **Product category**: supporting evidence only (a healthcare onboarding flow and a clinical monitoring console need different treatment).

Write the result in plain words in the Phase 2 plan and in `01-DESIGN.md` → Direction, with the reason: "The admin will feel calm and quick, flat with light borders and no decorative effects, because it is a data-heavy internal tool." Ask a plain question only when the evidence cannot decide ("Should the public site feel calm and serious, or lively and bold?").

**Motion level:** `none` · `subtle` (quick fades, state feedback, indicators that move within a component) · `expressive` (choreographed collapse and expand, entrances, small spring where the mood allows) · `rich` (adds celebratory moments, counters, drawn-in charts).
- An interactive web or app screen gets at least `subtle` unless there is a stated reason for less: the user asked for it, the brand forbids animation, or the environment cannot run it smoothly.
- Email and SMS are `none`: many email clients do not run CSS animation, and SMS has no visuals.

**Finish:** `flat` (borders and surface tints, no decorative shadows) · `soft` (layered soft shadows, faint borders) · `floating` (inset panels, large radius, top-edge highlight) · `bold` (accent glow, strong contrast). Default: the brand's existing finish, else `soft`, else `flat` for dense operator tools.

## 1. Required at every level (including `none`)

- **Focus is always visible**: an on-brand focus ring on every interactive element, shown immediately (it may also animate in).
- **Every state reads clearly**: hover (pointer devices), pressed, focus-visible, selected, disabled and loading, **where the element has that state**. A static label has none; a checkbox has no loading state. Do not invent states.
- **Layout stays controlled**: nothing squashes, overlaps or becomes unreadable while it changes; buttons keep their width while loading.
- **Compact forms keep their meaning**: a collapsed nav keeps icons and tooltips; a badge that shrinks to a dot keeps its accessible label; a count that matters stays readable.
- **Overlays state how they open and close**, even if the answer is "instantly".
- **Reduced motion**: under `prefers-reduced-motion: reduce`, only colour and opacity may animate. Everything else (travel, scale, width/height resizing, rotation, shake, morphing, stagger, counters, drawn-in charts, shimmer) jumps straight to its end state; skeletons become static.
- **No vague words as specs**: "smooth", "modern", "animated" or "nice transitions" never replace naming the behaviour, the token and what moves.

## 2. Motion tokens (defined once in `01-DESIGN.md`)

Define only the tiers the direction uses; values are defaults to adjust per brand.

| Token | Default | Use |
|---|---|---|
| `--dur-instant` | 100ms | press feedback, colour on hover |
| `--dur-fast` | 180-200ms | fades, label in/out, tooltips, icon swaps |
| `--dur-base` | 300-350ms | indicators moving, width/height changes, drawers, sheets |
| `--dur-slow` | 450-600ms | screen-level entrance, large layout shifts, celebratory moments |
| `--dur-highlight` | ~2s | a "just changed" highlight fading out (informational, not an interaction) |
| `--stagger-step` | 30-50ms | delay between items entering in sequence; `expressive` or `rich` only |
| `--ease-standard` | `cubic-bezier(.4,0,.2,1)` | most movement |
| `--ease-out` | `cubic-bezier(0,0,.2,1)` | things entering |
| `--ease-in` | `cubic-bezier(.4,0,1,1)` | things leaving |
| `--ease-spring` | `cubic-bezier(.34,1.56,.64,1)` | small overshoot (toggles, badges); `expressive` or `rich` only |

Rules:
- **Interaction transitions** (a control responding to the user) use the easing tokens, never `linear` or the bare `ease` keyword, and last at most 600ms.
- **Continuous or informational animation** is exempt from that cap: spinners and indeterminate progress may be `linear`; a "just changed" highlight may fade over `--dur-highlight`; a toast's countdown bar runs for its timeout.
- Prefer animating `transform` and `opacity`. Animate width or height only for the container actually being resized, or change it instantly.
- On constrained environments, no blur or translucent backgrounds.

## 3. Catalogue

`01-DESIGN.md` lists the rows it selects; briefs use only those. A **default** row is selected for every component the product has unless the direction gives a reason to leave it out (and says so); a **mood** row is selected only at `expressive`/`rich`, or when the finish calls for it. Rows for components the product doesn't have are never selected.

| Component | Behaviour | Kind |
|---|---|---|
| **Sidebar / nav rail** | Expanded and collapsed widths; width animates at `--dur-base`; labels fade out at `--dur-fast` before the width shrinks and fade in after it grows; tooltips on collapsed items; toggle reflects the state (chevron rotates); the profile card collapses to its avatar. | default |
| | Glowing active indicator; badge morphs to a dot (keeping its label); hover-to-expand mode (changes behaviour: Proposal). | mood |
| **Active indicator** (tabs, segmented control, one nav list, stepper) | One indicator slides to the new item **when both items are in the same component and visible together**. Across groups, scroll containers, distant items or a screen change, the selection changes immediately instead. Multi-select uses per-item border plus tint, never a travelling indicator. | default |
| **Tabs / segmented control** | Content cross-fades with a 4-8px shift in the direction of travel. | default |
| **Buttons** | Hover tint at `--dur-instant`; press scale to ~0.97; loading swaps the label for a spinner at the same width. | default |
| | Success briefly morphs to a check; hover lift. | mood |
| **Cards** | Clickable cards: cursor, hover tint or one elevation step, focus ring; selected: border plus tint. | default |
| | Hover lift of 2px. | mood |
| **Lists and tables** | Row hover tint; a newly added or edited row highlights then fades over `--dur-highlight`; removed rows collapse their height; skeletons in the layout of the real rows. | default |
| | Rows enter staggered by `--stagger-step` (first ~8 rows, first load only). | mood |
| **Modals and dialogs** | Backdrop fades; panel scales from ~0.96 and fades in at `--dur-base` `--ease-out`, leaves faster with `--ease-in`; phone: bottom sheet sliding up. | default |
| | Drag the sheet down to dismiss (changes behaviour: Proposal; never on destructive confirmations). | mood |
| **Drawers and side panels** | Slide from their logical `inline-end` edge (RTL mirrors); content fades in after the panel arrives. | default |
| **Menus, dropdowns, popovers** | Scale and fade from the trigger's corner (`transform-origin` set to it). | default |
| | A moving hover pill across items. | mood |
| **Toasts** | Slide in from their edge; older toasts shift smoothly; a visible countdown bar when they auto-dismiss. | default |
| | Swipe to dismiss on touch (changes behaviour: Proposal). | mood |
| **Inputs and forms** | Focus ring; validation message appears below the field on submit; success check fades in. | default |
| | Floating label; a small shake (2-3 cycles) on a failed submit. | mood |
| **Toggles, checkboxes, radios** | Knob slides; check mark appears; state colour cross-fades. | default |
| | Spring on the knob; check mark draws in. | mood |
| **Accordions** | Height animates; chevron rotates in sync; content fades in after the height opens. | default |
| **Search** | Results panel appears below the field; matched text highlighted; keyboard focus visible through results. | default |
| | Field expands from icon to full width. | mood |
| **Steppers and wizards** | Progress fill animates between steps; completed step shows a check; step content moves in the direction of travel. | default |
| **Numbers, KPIs, charts** | Values and deltas appear with the content. | default |
| | Counters tick up, chart lines draw in, bars grow from the baseline (first render only). | mood |
| **Screen changes** | The shell stays fixed; only the content region changes (fade plus 6-8px rise), where the tool keeps both screens in one view. | default |
| **Empty, success, error moments** | Icon or illustration with its copy. | default |
| | Small scale-in; one celebratory flourish on success. | mood |

Anything marked "changes behaviour" (drag-to-dismiss, swipe-to-dismiss, hover-to-expand, Undo after delete) is a **Proposal for PO approval**, listed under the brief's Proposals and not built until approved.

## 4. Finish layer

State per product in `01-DESIGN.md`, with the finish deciding the strength:

- **Elevation scale**: at least resting, raised and overlay. `flat`: borders and surface tints, one subtle shadow on overlays only. `soft` and above: each step a layered shadow token, never one hard shadow.
- **Surface treatment**: which panels float (inset with a gap), which get a tint or top-edge highlight, and whether any surface is translucent (not on constrained environments).
- **Radius hierarchy**: large on floating containers, medium on cards, smaller on inputs and buttons, full on pills and avatars; nested radii shrink so inner corners stay parallel.
- **Accent expression**: one or two of tinted selection backgrounds, coloured focus rings, glow on the active indicator (`bold` only), gradient strokes (`bold` only). Used consistently.
- **Icon set**: one family, one stroke weight, consistent optical size.

## 5. Weak vs strong

**Navigation** (an `expressive`, `floating` consumer app)

Weak:
> Sidebar with links. Collapsible. Highlight the active page.

Strong:
> Sidebar: floating panel 16px from the viewport edge, large radius, raised elevation. Widths 264px expanded and 80px collapsed; width animates at `--dur-base` `--ease-standard`. Labels fade out at `--dur-fast` before the width shrinks and fade in after it grows. One active indicator (4px bar on the inline-start edge plus a soft accent tint) slides between items in the list at `--dur-base`. The "Orders" count badge becomes an 8px dot when collapsed and keeps "Orders, 3 new" as its label. Collapsed items show tooltips. Reduced motion: no slide, no width animation, instant swap.

The same sidebar for a `subtle`, `flat` internal tool: fixed 248px, no collapse animation beyond an instant width change, active item gets a tint plus a 2px bar that changes immediately, focus ring on every link.

**Modal**

Weak:
> Show a modal to confirm deletion.

Strong:
> **Delete project** ConfirmDialog: backdrop fades in at `--dur-fast`; panel scales from 0.96 and fades in at `--dur-base` `--ease-out`, leaves at `--dur-fast` `--ease-in`. Primary **Delete** shows a spinner in place of its label while pending, same width. On success the dialog closes, the row collapses its height over `--dur-base`, and a toast "Project deleted" appears. Phone: bottom sheet sliding up; no drag-to-dismiss on this destructive confirmation.

**Data list**

Weak:
> A table of orders. Show loading state.

Strong:
> Orders table: row hover tint at `--dur-instant`. Loading: 8 skeleton rows matching real column widths (static under reduced motion). A row whose status changes cross-fades its StatusPill and shows a tint that fades over `--dur-highlight`.

## 6. Self-check

Answer yes to each, or fix the prompt:

- [ ] `01-DESIGN.md` states the direction (motion level and finish) with its reason, and the selected behaviours.
- [ ] Every section uses only those behaviours and the approved variants; none invents its own look.
- [ ] Every component lists only the states it actually has; focus is visible everywhere.
- [ ] Every travelling indicator moves within one component; multi-select uses border plus tint.
- [ ] Every collapse or compact state says what changes, in what order, and keeps required information.
- [ ] Every overlay states how it opens and closes, and its phone variant.
- [ ] Behaviour-changing gestures are under Proposals, not in the build.
- [ ] Reduced motion: only colour and opacity animate.
- [ ] No spec line relies on "smooth", "animated", "modern" or "nice transitions" alone.
