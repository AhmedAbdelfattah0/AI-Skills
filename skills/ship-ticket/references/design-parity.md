# Design parity — one complete comparison and one terminal impact slice

Loaded during PROVE when `ui_required`. The reference pin happens earlier, in
[understand.md](understand.md).

**Rule IDs govern code. Parity does not map to a rule ID.** Its citation is the
pinned design decision plus any named human-approved deviation.

## Scope — owned screens only

Parity fires for the screens this ticket exists to build. It does not compare
every screen that merely consumes a shared component changed by the ticket.

A shared-component change creates one separate ticket whose owned-screen list is
the enumerated affected consumers. That ticket performs one complete comparison
over that list and cannot create another consumer sweep for the same component
change.

## What PROVE produces before `F0`

Create `.specs/design-parity/<TICKET>.md` with:

- `design_ref`;
- each owned screen and its implementation path;
- its pinned reference path, or its approved unreferenced classification;
- accepted deviations already approved by a named human;
- empty schema-defined slots for the round-1 result and terminal outcome.

Run formatters and generators before the record sweep. The artifact's reviewed
prefix is frozen with the rest of the record before `F0`. Reviewer outputs fill
the defined result slots once; they do not rewrite that prefix.

Use stable component, selector, token, state and translation-key anchors. A line
number may be retained only as a historical locator bound to `F0`; it is never
updated to follow later edits. Persist lists and derive counts.

## Unreferenced screens

An unreferenced screen receives:

```text
NOT_APPLICABLE_NO_SCREEN_REFERENCE
approved_by
approval_date
reference_search
design_system_sources
```

It remains bound by the pinned design system, tokens, shared components and
conventions. If literal parity is required, stop before implementation and obtain
a committed reference.

## Round 1 — the sole complete comparison

Pass A receives the pinned reference, implementation, acceptance criteria and
comparison depth, with no BUILD conclusions.

For each reference-backed owned screen, compare the complete implementation
against `design_ref` at all three layers:

- **Structure — node by node:** sections, composition, empty/loading/error states
  and components.
- **Style — class and declaration:** layout, spacing, tokens, colour, typography
  and shadow.
- **Behaviour + i18n:** interactions, state and every locale and text direction
  the project ships. Omit only dimensions the project genuinely does not ship.

Run this complete comparison once, over `F0`.

**Use the repository's parity harness first whenever one exists.** Run its render,
snapshot, DOM or component comparisons across every owned screen, required state,
shipped locale and text direction, bind the output to `F0`, and hand those
mechanical differences to pass A as deterministic evidence. On a bilingual RTL
project this is the difference between reading every node twice by hand and
reading only what a harness cannot see.

**Do not manually repeat what the harness already compared** — nodes,
declarations, states or directions. Reserve the model's own read for visual
hierarchy, interaction feel, and rendering defects outside the harness's
demonstrated scope.

If no suitable harness exists, declare `PARITY | MANUAL — no repository harness`.
The complete manual comparison still runs; the ~20-minute REVIEW target is not
assured.

Pass A returns, per screen:

```text
screen
source_manifest_id
reviewer_identity
grade
divergences[]: id · layer · severity · stable reference anchor · stable implementation anchor
```

Grades are **Faithful**, **Minor**, **Major** or **Not-built**. Faithful and Minor
may pass. Every residual Major or Not-built result requires a human-approved
deviation already present before `F0`.

## Barrier 1 — derive the impact slice while repairing

Never repeat the complete screen comparison after round 1. For each UI change,
the fix packet records the narrowest dependency-closed slice that may have moved:

- template or DOM change — the changed subtree and its direct composition/layout
  contracts;
- selector, declaration or token change — the changed properties and every
  owned-screen node consuming them;
- behaviour, state or translation change — the changed state/key and every
  rendered occurrence in each shipped locale and direction;
- shared component change — every occurrence of that component inside the owned
  screens of this ticket.

This slice replaces the later complete comparison. If its boundary cannot be
proved, terminal parity is FAIL.

## Round 2 — terminal parity outcome

The terminal reviewer consumes pass A's complete `F0` result. When barrier 1 did
not change parity inputs, that result directly covers the final candidate.

When parity inputs changed, compare only the recorded impact slice against the
pinned reference, at the affected layers and in every applicable locale and
direction. Resolve each round-1 divergence touched by the repair and report any
regression inside the slice.

The final per-screen grade is derived from the round-1 result plus those targeted
resolutions. The terminal reviewer returns `parity_outcome: PASS | FAIL |
NOT_TRIGGERED` as part of the overall terminal verdict. There is no later parity
dispatch.

## CI

Where a merge-blocking artifact check exists, it validates:

- `persisted ui_required OR the repository's view-layer detector`;
- the artifact and its immutable-prefix digest;
- a complete round-1 result bound to `F0`;
- the recorded terminal impact slice when UI changed;
- `parity_outcome: PASS` bound to the final candidate manifest.

Missing or unparseable metadata fails closed. If the check is absent, declare
that once and do not wait for it.
