# Adapter: Claude Design canvas (Design artifacts in Claude)

Standalone Claude Design (claude.ai/design) closes on 2026-12-14 and moves into Claude, where a new design is a **Design artifact**: a canvas of artboards. This adapter targets that canvas. Claude's final shape after the move is not fully known; only what is listed under "Tested" below has been run. Re-test (verification-protocol.md §2) when the Design type changes.

## The format, in one paragraph

A canvas holds artboards; each artboard is one `.dc.html` Design Component page (`<x-dc>` markup plus a small `class Component extends DCLogic` script). UI is written as markup, never built by script, and nothing loads from the network except Google Fonts and files uploaded to the canvas. So the old React + Babel + JSX preview format does not run here. A component shared by several screens is its own `.dc.html` file mounted with `<dc-import name="X">`; it takes props, including callbacks. Screens link with `<a href="Other.dc.html">` in Play mode. Each artboard keeps its own state.

## Mapping the core contract

| Core | On the canvas |
|---|---|
| Container (G2) | ONE canvas per product. Every prompt after 02 says "add to the existing canvas {name}; do not start a new design". |
| Design system (G1) | Preferred: a **Design System** artifact built from `01-DESIGN.md` and installed on the canvas, so every artboard uses its tokens and real components. Fallback: prompt 01 builds the shared components as `.dc.html` files in the same canvas (e.g. `ds/Button.dc.html`, `ds/StatusPill.dc.html`) plus a style-guide artboard, and every screen mounts them with `<dc-import>`. |
| Screen key | Normally one artboard per screen key: `{section}-{screen}.dc.html` (`media-library.dc.html`); the entry screen is `Main.dc.html`. Exception: the screens of one shared journey (02-APP-MAP.md) are ONE journey artboard, `{journey}.dc.html`, whose screens are `<sc-if>` states; `02-APP-MAP.md` records which screen keys live inside it. |
| Layout / shell | The shell (sidebar, top bar) is one shared `.dc.html` with an `active` prop, mounted by every screen. |
| Navigation | `<a href="{target}.dc.html">` styled as the nav item or button (a `<button>` inside an `<a>` swallows the click). Mark working screens `is_interactive`. |
| Shared component | One `.dc.html`, owned by one section, mounted wherever it is used. Its result reaches the caller through a callback prop (`on-pick="{{onPick}}"`). |
| Shared journey state | A flow that must carry data across screens lives in ONE artboard that switches screens with `<sc-if>`. Separate artboards do not share state. |
| Screen size | Web app screens are PAGE artboards (`expand: "fill"`, fluid root, 1280-1440 wide). |
| Motion | CSS transitions in markup and `<helmet>` styles work inside a screen. Motion across a screen change is lost (the target artboard draws fresh), so a sliding indicator only slides within one artboard. |

## Adapter header for each prompt

Put this at the top of every pasted prompt, filled in:

```markdown
> Tool: Claude Design canvas. Container: the one canvas "{Project}" the user opened for prompt 00.
> Design system: {Design System "{name}" installed on the canvas | shared components in ds/ on this canvas}.
> Build each screen key as the PAGE artboard 02-APP-MAP.md assigns it: {section}-{screen}.dc.html, or a state inside its
> journey artboard {journey}.dc.html. Mount shared parts with <dc-import>; link artboards with <a href>, and move
> between screens inside a journey artboard with its own state. Do not create another canvas, and do not copy a
> shared component into a section.
```

Prompt 02 (app shell) creates the shell component, `Main.dc.html`, one placeholder artboard per standalone screen key and one placeholder journey artboard per shared journey (one `<sc-if>` state per screen key it holds), each titled "Designed in prompt NN" and all linked, so later prompts replace placeholders instead of adding loose screens.

## Tested (2026-10-14, Design type release 1791917617-36fa)

Two linked screens and two shared components on one canvas, run in Chrome:
- A shared Sidebar and a shared Media picker rendered inside both screens via `<dc-import>`.
- The picker's callback updated the calling screen (pick "Forest" → the editor's hero image changed).
- Links moved between screens in Play, both directions.
- An artboard kept its own state after leaving and coming back.
- The sidebar's active highlight jumped rather than slid when the screen changed (expected: separate artboards).
- No console errors.

## Untested (as of 2026-10-14)

- Editing a shared `.dc.html` and seeing every screen update (the G1 proof). The mechanism mounts the one file, so it should; it has not been run.
- Creating a Design System artifact from `01-DESIGN.md` and installing it on a canvas.
- A cross-screen journey held in one artboard with `<sc-if>`.
- An UPDATE prompt extending an existing canvas without duplicating screens or components.
- Prompts pasted by a user into Claude (the test was built directly as files).

- Standalone Claude Design before 2026-12-14: its Design Component mode uses the same `.dc.html` format, but this adapter has not been run there.

Until each passes, VERIFICATION.md records it as untested and the README says so.

## Troubleshooting

- **The tool says every design must be a Design Component, or produces `.dc.html` + `support.js`:** that is this format; it is correct here. If the prompts asked for JSX, switch the set to this adapter.
- **A section came back as a new canvas:** the prompt lacked the adapter header or the binding. Re-run it with both, naming the existing canvas.
- **A shared component appears twice under different names:** the brief listed it as new instead of as "Shared components used". Fix the binding and ask for the duplicate to be replaced by `<dc-import>` of the owner's file.
