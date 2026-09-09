# Design parity — the artifact, the grades, and the signature

Loaded during PROVE when `ui_required`. The reference pin happens earlier, in
[understand.md](understand.md).

**Rule IDs govern code. Parity does not map to any rule ID** — its citation is a
named design decision plus a human approver. Passing every `NG-*` / `BE-*` rule
does not mean the screen is the design.

## Who checks what, and why there are exactly two checks

1. **BUILD checked each screen as it was finished**, with the design files still
   in context — reference-backed against its reference, unreferenced against the
   design system.
2. **Pass A re-derives the verdict blind**, with no build context.

**Pass A is the sole post-build parity investigator.** A third comparison of the
same two things could find drift both missed — that is correlated redundancy, not
information-free duplication, and dropping it is a real if small cost in accuracy.
It is dropped deliberately: its findings fed the fix → invalidate → re-sign loop
that produced twelve signing rounds. **This is a named trade, not a claim that the
work was worthless.**

## What this step produces

`.specs/design-parity/<TICKET>.md`: the screen list and each screen's
classification. **No grade is produced here.**

**Nothing from BUILD reaches pass A.** Handing a blind reviewer the builder's
conclusions anchors it and destroys the independence that is the entire point.
Pass A receives only the pinned reference, the implementation, the acceptance
criteria and the required comparison depth. Its verdict is merged with BUILD's
results **afterwards, by you**, once both exist.

**Regenerate the draft if a later step changes UI production code** — an attack
fix, for instance. A draft describing the pre-fix screen would send pass A to
review the wrong thing.

## Only reference-backed screens are graded

An **unreferenced** screen (`reference: null` in the plan header) gets a declared
carve-out, not an investigation:

```
src/app/invoices/invoice-empty.component.ts
  | NOT_APPLICABLE_NO_SCREEN_REFERENCE
  | approved by <name>, <date>   (from the plan header)
  | built to the pinned design system: tokens, shared components, conventions
```

It is **not** exempt from the design system — tokens, shared components and
conventions still bind, and BUILD still checked them. What it is exempt from is a
parity *verdict*, because there is nothing to be faithful to. A screen the ticket
invents cannot honestly return Faithful, Minor, Major **or** Not-built; it can
only generate work.

**If the ticket actually requires literal parity for that screen, STOP before
implementing and get a reference committed.** Inventing one during the check is
the self-attestation this whole gate exists to remove.

## The comparison pass A runs

For each **reference-backed** owned screen, diff the implementation against the
**pinned** reference — the `design_ref` SHA, never "latest" — one row per
divergence with exact `ref file:line ↔ impl file:line` and a severity, at three
layers:

- **Structure** — node by node: presence, absence and composition of sections,
  states (empty, loading, error), and components.
- **Style** — class and declaration: layout, spacing, tokens, colour, type, shadow.
- **Behaviour + i18n** — interactions, state, and correctness in **every locale and
  text direction the project actually ships.** Drop this layer entirely if the
  project is single-locale LTR.

**Grades:** **Faithful** (no Blocker or Major) · **Minor** (token or spacing drift
only) · **Major** (structural or visual divergence) · **Not-built** (a reference
screen or section with no implementation).

**Screens shard, the pass does not.** Pass A is one reviewer with one whole-diff
scope; its parity work fans out per reference-backed screen and unions back into
one pass-A result. Four screens is four concurrent comparisons **inside** one
pass — not four separate reviewers, and not one agent walking four screens in
sequence.

**Use the repo's own tooling where it ships any** — render, snapshot, DOM or
component harnesses generate the structural, token, state and direction
differences mechanically, faster and reproducibly. It does **not** replace the
independent read: a harness cannot see visual hierarchy, interaction feel, or
rendering defects outside its own scope.

## Scope — per owned screen, not per consumer

Parity fires for the screens **this ticket exists to build**. It does not force a
node-by-node diff of every screen that merely consumes a shared component you
touched. A shared-component change opens a **separate, flagged parity-sweep task**
across its consumers.

## Signing

Nothing is signed during the review wave. Pass A returns an **unsigned** verdict
stamped with the scope digest it actually reviewed.

**Sign the final payload, not an intermediate one.** At close-out, once the
human-approved deviations and the stub → follow-up-ticket links are in place, the
payload stops changing. Only then does the independent reviewer sign. A signature
written earlier and appended to afterwards binds to something that no longer
exists.

**The fields, the scope digest, the payload digest, the same-reviewer rule and
the staleness rule are all in the spine's *Signatures* section** — one contract
covering both parity and the attack testing, so a non-UI security run is not left
undefined. Do not restate it here.

Parity's specifics: its **scope digest** covers every owned screen's
implementation and reference files at `design_ref`; its **payload** is
`design_ref` · the owned-screen list · the per-screen grade.

## The verdict

**PASS**, per reference-backed screen ⇔ **Faithful or Minor** after fixes, **or**
every residual Blocker/Major carries a **human-approved** accepted deviation —
**and** the artifact carries an independent signature bound to the final scope
digest — **and** every introduced stub links a follow-up ticket.

**FAIL** ⇔ otherwise, including a signature whose scope digest is stale.

**No self-written waiver clears a Blocker or Major.** Visual drift has no rule ID;
the record — decision, approver, date — *is* the citation.

## CI

Where the repo has the merge-blocking check installed (checked with the other
companions, up front), it rejects a UI-scoped PR unless the artifact exists, is
independently signed and is PASS — validating the signature's **binding fields**
(scope digest, payload digest, signer identity), not merely that a signer string
is present.

**It evaluates `persisted ui_required` OR its own view-layer diff detector, never
the persisted value alone.** The plan writes the ticket/AC/contract half before
implementation and therefore cannot know what the eventual diff touches; the
freeze recomputes it and updates the header. ORing the two means neither half can
suppress the other: a stale `ui_required: false` cannot hide a diff that touched
the view layer, and a diff that touched nothing cannot hide a ticket that owed a
screen and never built one — the case `Not-built` exists to catch. Missing or
unparseable metadata fails closed to `true`.

Derive the glob from where the UI really lives — `**/*.{html,scss,css}` plus the
repo's component files (`*.component.ts`, `*.tsx`, `*.vue`, `*.svelte`,
`*.blade.php`, `templates/**/*.html`).

**If the check is not installed**, declare that in the run record and do not wait
for it. Adding CI code after the freeze is unreviewed content in the commit.
