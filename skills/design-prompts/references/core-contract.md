# Core contract: what every prompt set contains, in any tool

The skill writes the design once in tool-neutral documents, then a thin adapter says how to build it in the chosen tool. A tool change (Claude Design moving into Claude, a switch to another generator) changes only the adapter. This file defines the documents, the binding that keeps every screen in one place, and the two gates every set must pass.

## 1. The two gates (pass or fail, ranked above every other quality bar)

**G1: one design system, followed everywhere.**
- One authoritative source: `01-DESIGN.md` in the prompt set, built once in the destination as the tool's shared design system (adapter §"Design system").
- Every brief uses its components by name and its tokens by name. No brief restates token values, defines its own buttons, colours, shadows or status tones, or invents a "look" for its section.
- Sections may differ only through **approved variants** that `01-DESIGN.md` itself defines (e.g. a dense variant for operator tables, a marketing variant with larger display type).
- Proof: changing one shared component in the destination changes it on every screen that uses it. Matching tokens alone is **not** a pass: a tool that regenerates components per screen with the same colours is disclosed as "styles only" and the gate stays failed.

**G2: one assembled design.**
- One container per product in the destination: one canvas, one project, one file or one codebase. Roles, shells and sections are never a reason for a second container.
- Every screen in `02-APP-MAP.md` exists in that container under its screen key, and navigation between screens works (links in a prototype, routes in code). A board that only shows screens in order is documentation, not assembly.
- Shared components exist once and are reused by reference; a later prompt never copies one into its section.
- Later prompts extend the same container; they never create a new one.

A set that cannot pass both gates in the chosen tool says so in its README, with what is missing. "Partial" or "styles only" is a disclosure, never a pass.

## 2. Deliverable tree

```
docs/design-prompts/                  (or where the user says)
  README.md                           run order, tool + adapter, gate status, Decisions for the PO, assets to upload
  00-Orientation.md                   context for the tool: product, gates, tool rules, language rules
  01-DESIGN.md                        the design system (authoritative; template: design-system-template.md)
  02-APP-MAP.md                       the assembled product + BINDING (authoritative; also builds the app shell)
  03-{Section}.md … NN-{Section}.md   one bound brief per section (large sections: part 1 + part 2)
  updates/{feature}.md                UPDATE mode output
  VERIFICATION.md                     gate results per section, dated (verification-protocol.md)
```

Each pasted prompt is the document itself with a short adapter header on top. There is never a second copy of `01-DESIGN.md` or `02-APP-MAP.md` restating their values.

**When the one container is born (the same rule in every adapter):** the user opens ONE new container (a new canvas, a new project, a new folder or repo) and pastes 00 into it. 00 builds nothing. 01 is the first build in that container (the design system). 02 builds the shells, navigation and one placeholder per screen key in the same container. Every later prompt extends it. As soon as the tool shows the container's link or path, the user writes it into the Binding blocks. No prompt ever creates a container.

## 3. `02-APP-MAP.md`: the assembled product

Decide this before any brief. It answers "what is one product here?"

- **Product and container**: the one product name and the one container it is built in.
- **Deployment boundaries vs sections**: a deployment boundary (a public marketing site served from another domain, transactional emails, a native mobile app) may ship separately, but it is still **designed in the same container**, on `01-DESIGN.md`, and listed here. Everything users move between inside the product (admin, editor, content, settings, role views) is a **section of one app**. Nothing gets its own container.
- **Layouts**: the shells the product uses (main app shell, full-screen editor, auth) and which screens use which.
- **Screen table**: every screen key, its section, its layout, its parent nav item, and the screens it links to.
- **Shared components**: every component used by more than one section (e.g. MediaPicker), the section that owns it, and its inputs and outputs (what it returns to its caller).
- **Shared journeys**: flows that carry data across screens (pick an image in the editor from the media library, a draft that survives navigation). The adapter decides how its tool holds that state. Each journey has **one owner prompt** that builds its container (journey artboard, store slice) and its own screens; a later prompt whose screen key lives inside the journey adds only its own state or screen to it, listed as an exact edit, and leaves every existing state unchanged.
- **Prompt batches**: which prompt builds which sections (split rule: ~15-18 screens or one giant tool per prompt).

Skeleton:

```markdown
# {Project} app map

> {Adapter header.} Build in the existing {container}: the shells, the navigation, and one placeholder per
> screen key below (title + "Designed in prompt NN"), all linked. Later prompts replace placeholders.

## Product and container
{Product name} · container: {name, link or path once the tool shows it} · design system: built by prompt 01

## Deployment boundaries
{Separate deliverables (marketing site, emails, mobile app), each designed in this container; or "none"}

## Layouts
| Layout | Used by | Contains |
|---|---|---|
| main-shell | admin, editor, content | sidebar nav, top bar, search, user menu |

## Screens
| Screen key | Section | Layout | Nav parent | Links to | Built by prompt |
|---|---|---|---|---|---|
| media-library | content | main-shell | Media | editor-page | 03 |

## Shared components
| Component | Owner section | Used by | Inputs | Returns to caller |
|---|---|---|---|---|
| MediaPicker | content | editor, settings | mode (pick/browse) | the picked asset |

## Shared journeys
| Journey | Screens | Data carried | Held in (per adapter) |
|---|---|---|---|
| choose hero image | editor-page → MediaPicker → editor-page | asset id, alt text | canvas: journey artboard `editor-hero.dc.html`; code: `store.jsx` |

## Prompt batches
| Prompt | Sections | Screen keys |
|---|---|---|
```

## 4. The BINDING block

Every brief from `03` on starts with this block, filled from `02-APP-MAP.md`. Names alone do not stop duplication; the binding tells the tool exactly where the work goes.

```markdown
## Binding
- Container: {canvas / project / file / repo name, and its URL or path once it exists}
- Design system: {where 01-DESIGN.md lives in the tool, and its version or date}
- This prompt owns: {section(s)} → screen keys {key, key, …}
- Extends: {the shell and seams from 02, or part 1 of this section}
- Links out to: {screen keys in other sections}
- Shared components used: {name (owner section), …}; new shared components this prompt creates: {name, inputs, outputs}
- Do not touch: every screen and file not listed above
```

The container's link or path is filled in by the user as soon as the tool shows it (§2); the README tells them to.

## 5. Briefs are self-contained in task, not in design system

Each brief repeats the task context it needs (product in 3-5 lines, this section's users and jobs, the binding) so it works pasted alone. It references the design system by component and token **name**; it never restates values from `01-DESIGN.md`.

## 6. Proposals stay pending

Anything new (a feature, a font, a renamed nav item, a gesture that changes behaviour) is listed under "Proposals for PO approval" in the README and in a `## Proposals (not to build yet)` section at the end of the brief. The tool is told not to build them. Once the PO approves one, it moves into the brief's normal sections (or an update prompt) and is built.

## 7. UPDATE mode

UPDATE reads the existing `01-DESIGN.md` and `02-APP-MAP.md` (ask for them, or for the container, if they are missing) and writes one focused brief plus, only when needed, a scoped amendment: the exact lines to add to `01-DESIGN.md` (a new token, a new component variant) or `02-APP-MAP.md` (a new screen key and its links). It never rewrites either document and never adds design-system values inside the feature brief.
