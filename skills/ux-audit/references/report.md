# REPORT — evidence-backed findings and coverage

Use this reference to turn one completed capture into the audit report without overstating evidence or changing application code.

Write `.specs/ux-audit/<run-id>/ux-audit-report.md`. The header records the
target, commit SHA when the target is a Git checkout, base URL, audited routes,
viewports, schemes, DESIGN.md source, loaded packs, and each lane's status from
`lanes.json`. From `stack.json`, list every detected framework with confidence
and the evidence supporting detection.

## Findings

Assign stable-in-report IDs in discovery order: `UXF-001`, `UXF-002`, and so
on. Rule IDs come only from `rules.md`.

| ID | Rule | Screen · viewport · scheme | Severity | Evidence | Recommended fix | Identity-safe |
|---|---|---|---|---|---|---|

Start severity from the rule's `Sev` column: `C` Critical, `H` High, `M`
Medium, `L` Low. Raise or lower it only with a stated reason based on the
screen's business criticality, the issue's reach, and the reversibility of its
effect. Do not score or average findings.

Evidence is either a screenshot path relative to the run directory or a
measured value with its JSON source. Axe output is automated evidence, not a
WCAG conformance claim. Separate lanes never substitute for one another; no
evidence means a coverage gap, not a pass.

## Artifact interpretation

Convert artifacts to findings only when their evidence demonstrates a rule
failure. Otherwise mark the applicable coverage row checked-pass or gap.

| Artifact | Rule mapping and decision |
|---|---|
| `stack.json` | Record frameworks, versions, confidence, evidence, token sources, vendor stylesheets, template globs, and scales. `unknown` makes declared-token analysis a gap, not rendered analysis. |
| `axe.json` | Map each violation to the applicable `A11Y-*` rule from `rules.md`; retain the axe rule ID as evidence, never as the finding's Rule value. Incomplete checks are gaps unless another required lane resolves them. |
| `contrast.json` | Map failed text contrast to `A11Y-01`, failed non-text contrast to `A11Y-02`, and LOCKED brand failures to `ID-02` as well. `unmeasurable` is a gap. Cite colors, ratio, requirement, and proposal when present. |
| `focus.json` | Map missing indicators to `A11Y-06`, obscured focus to `A11Y-07`, and illogical order or traps to `A11Y-08` or `A11Y-05` as demonstrated. Cite the step and selector. |
| `targets.json` | `below24: true` fails `A11Y-09`; `below44: true` with `below24: false` is a recommendation only, not a WCAG failure. |
| `tokens.json` | Map spacing, type, palette, radius, shadow, and duplication evidence to applicable `VIS-*` rules. Judge off-scale values against the stack-aware scale. Turn app-authored `declared.arbitrary` entries into findings that cite file:line; framework defaults alone are never findings. Any section marked `partial: true` leaves its uninspected portion as a gap. Do not turn every raw value into a separate finding. |
| `perf.json` | Map LCP, CLS, and configured-interaction measurements to `PERF-*`. LCP and INP are lab measurements, not field Core Web Vitals. A missing configured interaction is a `PERF-07` gap. |
| `motion.json` | Map measured duration, property, token, and reduced-motion results to applicable `MOT-*` rules. A null reduced-motion result is a gap. |
| `reflow.json` | Map horizontal scroll to `A11Y-19` and `RESP-02`; map failed 200% zoom or text spacing to `A11Y-20`. |
| `theme.json` | Map detected dark-theme behavior to `MOD-01`; `ambiguous` is a gap. Absence is reported as checked only when the project does not claim dark mode. |
| `rtl.json` | Map reachable RTL behavior to `I18N-*`; if DESIGN.md says RTL or both but RTL is not reachable, record gaps for the affected rules. |

## Visual review

Review every successful screenshot separately. Apply only `V` checks, including
`A/V`, from the loaded sections. Cite the screenshot's relative path and name
the observed region. Do not visually pass automated, keyboard, or manual rules.

When the same root issue appears across viewports, create one finding and list
all affected viewports in `Screen · viewport · scheme` and Evidence. Keep
separate findings when causes or fixes differ. A missing or failed screenshot is
a visual-lane gap for its route, viewport, scheme, and scenario.

## Identity decision

Set `Identity-safe` to `yes` only when the recommendation preserves every
LOCKED value and refines rather than replaces a signature component. Set it to
`no` when a LOCKED item itself must vary to comply. For `no`, recommend the
minimal compliant variant and owner approval; never recommend replacement.

## Coverage and tokens

The coverage matrix has one row for every rule in Core sections 1–16, section
21, and every loaded domain pack. Record its required lane and exactly one
result: `checked-pass`, `finding`, or `gap`. For mixed checks such as `A/V`,
record both lanes; a pass requires both. Name the finding IDs or the reason and
remediation for every gap.

Summarize token inconsistency from `tokens.json`: rendered and declared counts,
off-scale values, duplication, and affected screens. Include a proposed token
set for spacing, type, radius, shadow, and color. Derive color tokens from the
LOCKED brand colors through tints, shades, and semantic roles (`ID-03`); do not
introduce an unrelated palette. Present `tokens.json.proposal.format` and its
`snippet` directly so the proposal uses the detected framework's idiom. Keep
declared and rendered counts separate. Apply [frameworks.md](frameworks.md)
when interpreting adapters, partial extraction, and on-scale defaults.

## Fix plan

Order groups by highest severity, then lowest effort. Group by screen or shared
component, and make each group one small scoped task. Tag every group exactly
one of `token-only`, `component restyle`, or `layout change` (`ID-05`). A layout
change that affects a signature layout needs owner approval. Findings authorize
no implementation. Phrase each recommendation in the framework's native
mechanism: a Tailwind utility or theme token, Bootstrap variable or utility,
Material or component-library theme token, CSS-in-JS theme value, or CSS custom
property. Never recommend a raw CSS override that fights the active framework.

## Compact report skeleton

```markdown
# UX audit — <target> — <run-id>

- Commit: <sha | not a Git checkout>
- Base URL: <redacted URL>
- Routes / viewports / schemes: <values>
- DESIGN.md: <source> · packs: <Core, ID, ...>
- Frameworks: <id, version, confidence, evidence from stack.json>
- Lanes: <automated/measured/keyboard/visual/manual from lanes.json>

## Findings
| ID | Rule | Screen · viewport · scheme | Severity | Evidence | Recommended fix | Identity-safe |
|---|---|---|---|---|---|---|

## Coverage matrix
| Rule | Lane | Result | Finding / evidence / gap |
|---|---|---|---|

## Token inconsistency and proposed token set
<stack-aware summary; proposal.format and proposal.snippet; LOCKED brand colors>

## Prioritized fix plan
### <screen or component> — <token-only | component restyle | layout change>
<one small scoped task; linked finding IDs; severity; effort; approval if needed>
```

Counts in the summary must equal the listed findings and coverage rows. Use
`none` for an empty section; never leave it blank.
