# Design parity — one complete comparison and one repair impact slice

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

## What PROVE produces before REVIEW

Create `.specs/design-parity/<TICKET>.md` with:

- `design_ref`;
- each owned screen and its implementation path;
- its pinned reference path, or its approved unreferenced classification;
- accepted deviations already approved by a named human.

Formatters, generators and documentation updates finish in PROVE. The primary
reviewer's comparison result is appended to the plan's execution block with the
candidate ID and artifact digest; do not rewrite the evidence artifact to insert
a verdict.

Use stable component, selector, token, state and translation-key anchors. A line
number is only a locator bound to the reviewed candidate. Persist lists and
derive counts.

## Unreferenced screens

An unreferenced screen receives:

```text
outcome: NOT_APPLICABLE
reason_code: NO_SCREEN_REFERENCE
approved_by
approval_date
reference_search
design_system_sources
```

It remains bound by the pinned design system, tokens, shared components and
conventions. If literal parity is required, use `WAIT_FOR_USER` before implementation and obtain
a committed reference.

## Primary review — the sole complete comparison

The independent primary reviewer or full-stack frontend review partition receives
the pinned reference, implementation,
acceptance criteria and comparison depth, with no BUILD conclusions.

For each reference-backed owned screen, compare the complete implementation
against `design_ref` at all three layers:

- **Structure — node by node:** sections, composition, empty/loading/error states
  and components.
- **Style — class and declaration:** layout, spacing, tokens, colour, typography
  and shadow.
- **Behaviour + i18n:** interactions, state and every locale and text direction
  the project ships. Omit only dimensions the project genuinely does not ship.

Run this complete comparison once, over the initial reviewed candidate.

**Use the repository's parity harness first where it compares against the pin.**
Run its render, snapshot, DOM or component comparisons across the owned screens,
required states, shipped locales and directions it covers, bind the output to
the candidate ID, and hand those mechanical differences to the primary reviewer.
On a bilingual RTL project this is the difference between reading every node twice
by hand and reading only what a harness cannot see.

**A harness substitutes for a dimension only if it demonstrably compares the
reviewed candidate against the pinned `design_ref` for that dimension, state and
locale.** This is the whole test, and most harnesses fail it: a snapshot suite
compares the implementation to *its own committed snapshot*, which moves when the
implementation moves. Such a suite proves the screen did not change unintentionally
— it says nothing about whether the screen matches the design, and accepting it as
parity evidence would let design drift through unseen while the run reported the
dimension covered.

So, per dimension: **compared against the pin** → the model does not repeat it;
**anything else** → supplementary evidence only, and the independent node and
declaration read still runs. Record which dimensions the harness actually covered.

Whatever the harness covered, the model's own read always keeps visual hierarchy,
interaction feel, and rendering defects outside the harness's demonstrated scope.

If no suitable harness exists, declare `PARITY | MANUAL — no repository harness`.
The complete manual comparison still runs. During UNDERSTAND, set and record a
realistic primary-review ceiling from the number of owned screens, states,
locales and directions rather than discovering the default is too short after
dispatch.

The primary reviewer returns, per screen:

```text
screen
candidate_id
reviewer_identity
grade
divergences[]: id · layer · severity · stable reference anchor · stable implementation anchor
```

Grades are **Faithful**, **Minor**, **Major** or **Not-built**. Faithful and Minor
may pass. Every residual Major or Not-built result requires a human-approved
deviation already present before the reviewed candidate was captured.

## Review repair — derive the impact slice

Never repeat the complete screen comparison after the initial review. For each UI
repair, the execution event records the narrowest dependency-closed slice that
may have moved:

- template or DOM change — the changed subtree and its direct composition/layout
  contracts;
- selector, declaration or token change — the changed properties and every
  owned-screen node consuming them;
- behaviour, state or translation change — the changed state/key and every
  rendered occurrence in each shipped locale and direction;
- shared component change — every occurrence of that component inside the owned
  screens of this ticket.

This slice replaces a later complete comparison. If its boundary cannot be
proved, confirmation parity is FAIL.

## Targeted confirmation

The primary review result directly covers the final candidate when REVIEW makes
no UI repair.

When parity inputs changed, the same independent primary workflow compares only
the recorded impact slice against the pinned reference, at the affected layers
and in every applicable locale and direction. Resolve each initial divergence
touched by the repair and report any regression inside the slice.

The final per-screen grade is derived from the initial result plus those targeted
resolutions. The reviewer returns `parity_outcome: PASS | FAIL | NOT_TRIGGERED`
inside its confirmation. There is no later parity dispatch.

## CI

Where a merge-blocking artifact check exists, it validates:

- `persisted ui_required OR the repository's view-layer detector`;
- the artifact and its content digest;
- a complete primary-review result in the plan's execution block, bound to the
  initial candidate ID;
- the recorded confirmation impact slice there when UI changed;
- `parity_outcome: PASS` there, bound to the final candidate ID.

Missing or unparseable metadata fails closed. If the check is absent, declare
that once and do not wait for it.
