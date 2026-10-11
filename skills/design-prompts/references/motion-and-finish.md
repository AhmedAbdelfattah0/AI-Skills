# Motion and finish standard: how the UI should feel, not only what it shows

The depth standard makes a design complete. This standard makes it feel modern. A screen can list every field and still look like a 2015 admin template: highlights that jump, panels that snap, flat boxes with no depth, hover states that do nothing. Claude Design treats animation and finish as optional polish unless the prompt makes them requirements, so every prompt states them as requirements.

The reference case: a collapsible sidebar where one glowing indicator slides between items, labels fade before the width shrinks, a count badge morphs into a dot, the toggle rotates in sync, and the panel floats with a soft shadow and an inner edge highlight. Nothing about it is colour. All of it is choreography and depth. Apply that same thinking to every component on every surface.

The snippets below use a made-up product only to show the level of detail. Never copy their content into a real project.

## 1. The five principles

1. **Shared elements move; they do not reappear.** When "the active thing" changes (nav item, tab, segment, selected row, step), one indicator element travels from the old position to the new one. Never restyle the old item off and the new item on.
2. **Choreograph, do not just transition.** When several things change together, they change at different speeds in a deliberate order: content that would distort (text, icons) leaves first and returns last; containers resize in between. Nothing squashes, wraps or overlaps mid-animation.
3. **Morph, do not hide.** An element that has a compact form changes shape into it (badge to dot, search field to icon button, full button to icon button, card to row) instead of disappearing.
4. **Depth is layered, not one shadow.** Raised surfaces combine a soft deep shadow, a faint 1px border, a subtle top-edge inner highlight, and a gentle vertical gradient or tint. Floating panels sit off the edge with a margin and a large radius.
5. **Every interactive element answers.** Hover, press, focus-visible, selected, disabled and loading each look different, and each change is animated with the motion tokens.

## 2. Motion tokens (the Foundation defines them; every surface uses them)

Put these in `tokens.css` and refer to them by name in every prompt. Values are defaults; adjust per brand mood, but keep the four tiers.

| Token | Default | Use |
|---|---|---|
| `--dur-instant` | 100ms | press feedback, colour on hover |
| `--dur-fast` | 180-200ms | fades, label in/out, tooltips, icon swaps |
| `--dur-base` | 300-350ms | indicators sliding, width/height changes, drawers, sheets |
| `--dur-slow` | 450-600ms | page-level entrance, large layout shifts, celebratory moments |
| `--ease-standard` | `cubic-bezier(.4,0,.2,1)` | most movement |
| `--ease-out` | `cubic-bezier(0,0,.2,1)` | things entering |
| `--ease-in` | `cubic-bezier(.4,0,1,1)` | things leaving |
| `--ease-spring` | `cubic-bezier(.34,1.56,.64,1)` | small, playful overshoot (toggles, badges, likes); only where the mood allows |

Rules: never `linear` for UI movement; never the bare `ease` keyword; never a transition longer than 600ms on a control; animate `transform` and `opacity` by preference, width or height only for the container being resized.

`prefers-reduced-motion: reduce` keeps state changes visible (colour, opacity) but removes travel, scale and stagger.

## 3. Pattern catalogue

Every prompt names the patterns its components use, by these names, with the specifics filled in. Include each one that applies to the surface; do not add patterns the surface has no component for.

| Component | Required behaviour |
|---|---|
| **Sidebar / nav rail** | Expanded and collapsed widths; width animates at `--dur-base`; labels fade out at `--dur-fast` before the width shrinks and fade in after it grows; one sliding active indicator (bar or pill, with glow or tint per mood); badges morph to dots when collapsed; tooltips on collapsed items; toggle on the panel edge rotates with the state; optional hover-to-expand mode; section labels shrink to centred short forms; the user/profile card collapses to its avatar. |
| **Tabs / segmented control** | One underline or pill indicator that slides and resizes to the target tab; content cross-fades with a small 4-8px shift in the direction of travel. |
| **Buttons** | Hover lift or tint at `--dur-instant`; press scale to ~0.97; loading state swaps the label for a spinner without changing the button width; success can briefly morph to a check. |
| **Cards** | Hover raises the shadow one step and lifts 2px; clickable cards show a cursor change and a focus ring; selected cards get a border plus tint, not only a colour change. |
| **Lists and tables** | Rows enter with a short stagger (30-50ms per row, capped at about 8 rows) on first load only; row hover tint; a newly added or edited row highlights then fades over ~2s; removed rows collapse their height instead of vanishing; skeletons shimmer in the layout of the real rows. |
| **Modals and dialogs** | Backdrop fades; panel scales from ~0.96 and fades in at `--dur-base` with `--ease-out`; leaves faster with `--ease-in`; on phones becomes a bottom sheet that slides up and can be dragged down. |
| **Drawers and side panels** | Slide from their edge (logical `inline-end` side, so RTL mirrors); content inside fades in slightly after the panel arrives. |
| **Menus, dropdowns, popovers** | Scale and fade from the trigger's corner (set `transform-origin` to it); items highlight with a moving hover pill if the mood allows. |
| **Toasts** | Slide in from their edge, stack with the older ones shifting smoothly, auto-dismiss with a visible progress bar, swipe to dismiss on touch. |
| **Inputs and forms** | Focus ring animates in; floating or animated label if the design uses labels inside the field; validation message slides down and the field shakes once (small, 2-3 cycles) only on submit; success check fades in. |
| **Toggles, checkboxes, radios** | Knob slides with a slight spring; check mark draws in; state colour cross-fades. |
| **Accordions and expandable sections** | Height animates; chevron rotates in sync; content fades in after the height opens. |
| **Search** | Field expands from icon to full width; results panel drops in; matched text highlighted; keyboard focus moves visibly through results. |
| **Steppers and wizards** | Progress fill animates between steps; completed step morphs number to check; step content slides in the direction of travel (forward vs back). |
| **Numbers, KPIs, charts** | Counters tick up on first view; chart lines draw in; bars grow from the baseline; deltas fade in after the value. Only on first render, never on every update. |
| **Page and route changes** | Shell stays fixed; only the content region transitions (fade plus 6-8px rise). The active nav indicator travels to the new route at the same time. |
| **Empty, success, error moments** | Illustration or icon enters with a small scale-in; success can use one celebratory flourish (a check draw, a short confetti burst) where the mood allows. |

## 4. Finish layer (depth, surface and detail)

State these per surface in "Visual and UX requirements", with the surface's mood deciding how strong they are:

- **Elevation scale**: at least three steps (resting, raised, overlay), each defined as a layered shadow token, never one hard shadow.
- **Surface treatment**: which panels float (inset from the viewport edge with a gap), which get a gradient or tint, which get the top-edge inner highlight, and whether any surface uses a translucent blurred background.
- **Radius hierarchy**: large on floating containers, medium on cards, smaller on inputs and buttons, full on pills and avatars. Nested radii shrink so inner corners stay parallel to outer ones.
- **Accent expression**: how the accent shows beyond fills: glow on the active indicator, tinted backgrounds on selection, coloured focus rings, gradient strokes. Pick one or two and use them consistently.
- **Icon set**: one icon family, one stroke weight, consistent optical size; icons animate state where it reads naturally (chevrons rotate, hamburger to close).
- **Focus visibility**: a visible, on-brand focus ring on every interactive element, animated in, never removed.

## 5. Weak vs strong

**Navigation**

Weak:
> Sidebar with links. Collapsible. Highlight the active page.

Strong:
> Sidebar (floating panel, 16px from the viewport edge, large radius, raised elevation, faint top-edge highlight). Widths 264px expanded and 80px collapsed; width animates at `--dur-base` `--ease-standard`. Labels and section titles fade out at `--dur-fast` before the width shrinks and fade in after it grows. One active indicator: a 4px bar on the inline-start edge with an accent glow plus a soft accent tint behind the item; it slides to the new item at `--dur-base` on click and on route change. The "Orders" count badge morphs into an 8px dot when collapsed. Collapsed items show a tooltip that fades in and shifts 4px. A round toggle on the panel edge rotates 180° with the state. Reduced motion: no slide, no width animation, instant swap.

**Modal**

Weak:
> Show a modal to confirm deletion.

Strong:
> **Delete project** ConfirmDialog: backdrop fades in at `--dur-fast`; panel scales from 0.96 and fades in at `--dur-base` `--ease-out`, leaves at `--dur-fast` `--ease-in`. Primary **Delete** shows a spinner in place of its label while pending, width unchanged. On success the dialog closes, the row collapses its height over `--dur-base`, and a toast slides in "Project deleted" with **Undo** and a 5s progress bar. Phone: bottom sheet sliding up, drag handle, drag down to dismiss.

**Data list**

Weak:
> A table of orders. Show loading state.

Strong:
> Orders table: on first load, rows enter with a 40ms stagger (first 8 rows only), fade plus 6px rise. Row hover tint at `--dur-instant`. Loading: 8 shimmering skeleton rows matching real column widths. A row whose status changes cross-fades its StatusPill and flashes a tint that fades over 2s.

## 6. Self-check (add to the depth-standard self-check)

Answer yes to each, or fix the prompt:

- [ ] The Master names the motion level and the finish level for each surface mood.
- [ ] The Foundation defines duration, easing and elevation tokens, and every animated component lists its states and transitions.
- [ ] Every "active" or "selected" pattern uses a shared moving indicator, not a per-item restyle.
- [ ] Every collapse, expand or compact state says what fades, what resizes, in which order, and what morphs instead of disappearing.
- [ ] Every overlay states how it enters and leaves, and its phone variant.
- [ ] Every button, card, row and field lists hover, press, focus-visible, disabled and loading.
- [ ] Reduced-motion behaviour is stated.
- [ ] No spec line says only "smooth", "animated", "modern" or "nice transitions" without naming the pattern, the token and what moves.
