# Verification protocol: proving the two gates

Two different things get verified, and they are never confused:

- **The user's output** (§1): did this prompt set, run in this tool, produce one assembled design on one design system? Checked per phase, then once at the end.
- **An adapter's capability** (§2): can this tool pass the gates at all, and how? Tested once per adapter, and again whenever the tool changes. A passed adapter test does not make a user's output pass; a user's output can still fail.

Results go in `VERIFICATION.md` in the prompt set, dated, with the tool and its version or release where it shows one.

## 1. The user's output, phase by phase

Ask the user to check, or check yourself when you can open the result. Each phase has its own checks; an unchecked item is fixed (an update prompt scoped to the defect) before the next phase.

**After 01 (design system)**
- [ ] It was built inside the one container, as the tool's shared design system (per the adapter).
- [ ] Every component in 01-DESIGN.md exists with its states; the STATUS map is complete; the style guide screens show them.

**After 02 (app map and shell)**
- [ ] Shells, navigation and one placeholder per screen key (or journey placeholder) exist in the same container.
- [ ] Every nav item and placeholder link reaches its target, both directions.

**After each section prompt (03 on)**

*G1: one design system*
- [ ] Shared UI uses design-system components and tokens; section-only components (the adapter's section component file or artboard) are built from design-system primitives and tokens. No new colours, buttons, shadows or status tones.
- [ ] Every status uses the STATUS map tone.
- [ ] The section uses only approved variants.
- [ ] Nothing from Proposals was built.

*G2: one assembled design*
- [ ] The section landed in the existing container, not a new one.
- [ ] Every screen key the prompt owns exists, and its placeholder from prompt 02 was replaced, not duplicated.
- [ ] Navigation works into and out of the section, both directions.
- [ ] Shared components appear by reference (the owner's one copy), not re-created inside the section.
- [ ] Unrelated screens and files are unchanged.

**Final assembly gate (after the last prompt)**
- [ ] G1 proof on the real output: change one shared component (e.g. the primary Button or the MediaPicker) once in its source; every screen that uses it shows the change without being regenerated. Until this is done, G1 is **pending**, not passed.
- [ ] Every shared journey in 02-APP-MAP.md runs end to end and keeps its data after navigating away and back. Until each is run, G2 is **pending**.
- [ ] Every screen key in 02-APP-MAP.md is built (no placeholders left) and reachable.

`VERIFICATION.md` holds the phase checklists above (after 01, after 02, per section, final assembly gate), copied as they are, followed by this results table. Record the outcome per prompt and at the gate:

```markdown
| Prompt | Date | Tool / release | G1 | G2 | Notes |
|---|---|---|---|---|---|
| 03-Content | 2026-10-20 | Claude Design canvas / 1791917617-36fa | pass | fail: MediaPicker re-created in Content | fixed by updates/content-media-picker.md |
```

## 2. Adapter capability test

Run a small two-section brief with one shared component and one shared journey, in a fresh container. Every step must pass for the adapter to be marked tested.

1. **Design system once**: build a 5-component design system; confirm the tool holds it as one shared source.
2. **Two sections, one container**: build section A and section B in the same container, linked.
3. **Shared component**: a component owned by A (e.g. a picker) is used by B.
4. **Propagation (G1 proof)**: change the shared component once (and one design-system component once); both sections show the change without being regenerated.
5. **Navigation**: forward and back between A and B work from the nav and from in-page links.
6. **Shared journey**: a flow that starts in A, uses B's component and returns its result to A, keeping it after navigating away and back.
7. **Extension**: an UPDATE prompt adds a screen to B; existing screens, shared sources and links are intact and nothing is duplicated.
8. **Pasted prompts**: the steps above are run from the skill's prompts as a user would paste them, not only built directly.

Record each step as pass, fail or untested with the date and tool release. The adapter file's "Tested" and "Untested" lists must match this record.

## 3. Before delivering a prompt set (the skill's own checks)

- [ ] Every screen key in `02-APP-MAP.md` is owned by exactly one brief; no brief owns a key that is not in the map.
- [ ] Every brief has a Binding block; every shared component it uses is in the map with its owner.
- [ ] No brief restates design-system values or defines its own visual language.
- [ ] Proposals appear only under Proposals sections and the README, never in build instructions.
- [ ] The README states the tool, the adapter, and the adapter's tested status in plain words.
