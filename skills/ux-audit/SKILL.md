---
name: ux-audit
description: |
  Report-only UX/UI audit of a user-supplied running web interface against a
  broad modern UX rule catalogue. Preserves the project's identity through
  DESIGN.md LOCKED items, separates evidence lanes, captures responsive states,
  and writes an evidence-backed report without editing application code.

  Always trigger for /ux.audit, /ux-audit, "audit the UI", "UX review", "UI
  review", "check this against modern UX", "why does this look outdated",
  "does this UI follow best practices", or "review my screens". This skill
  produces a report only, never edits app code, and preserves DESIGN.md LOCKED
  items.
  Do not use for implementing fixes, code-level review (code-quality family),
  security review (security-audit), whole-app release audit (project-audit), or
  creating new designs (frontend-design).
---

# /ux-audit — review a running interface, preserve its identity

Audit a user-supplied running web UI against [the rule catalogue](references/rules.md), collect evidence across responsive views and states, and produce a prioritized report without changing the application's code or recognizable identity.

## What this is not

| Use instead | When |
|---|---|
| `project-audit` | You need a whole-application release assessment across source, builds, journeys, contracts, operations, and security. |
| `angular-code-quality` or the `code-quality` family | You need code-level or diff-level architecture and implementation review. |
| `security-audit` | You need a whole-codebase static security review. |
| `audit`, `critique`, `normalize`, or `polish` | You want design-family diagnosis or edits; those skills may change an interface, while this skill never does. |
| `design:accessibility-review` | You need accessibility-only review; this skill covers the full UX catalogue under an identity lock. |

## Invariants

- **Report only.** Never modify application code. The only target writes are a
  root `DESIGN.md`, only when the user accepts the promoted draft, and
  `.specs/ux-audit/<run-id>/**`. Record `git status --porcelain` before writing
  and compare it after the run.
- **The user runs the app.** Never start, restart, build, seed, or deploy it.
  Require a running base URL and audit only user-supplied routes.
- **Identity is locked.** Never recommend changing a DESIGN.md LOCKED item
  (`ID-01`). When one fails, mark `Identity-safe: no`, propose only the minimal
  compliant variant, and require owner approval (`ID-02`).
- **Evidence lanes never substitute.** Automated, measured, keyboard, visual,
  and manual evidence prove only their own checks. No evidence is a gap, never a
  pass. Axe output is not a WCAG conformance claim.
- **Framework defaults are not findings.** Findings require app-authored
  deviations. Declared and rendered token counts stay separate, and fixes use
  the detected framework's native mechanism rather than fighting it with raw
  overrides.
- **Rule IDs are closed.** Use only IDs in `references/rules.md`; findings are
  `UXF-001`, `UXF-002`, and so on.

## Phases

| Phase | Entry | Exit | Load |
|---|---|---|---|
| **IDENTITY** | target root selected | existing DESIGN.md parsed, or identity derived from the code into `DESIGN.draft.md` with evidence and confidence; uncertain items locked, never asked | [design-md.md](references/design-md.md), [rules.md](references/rules.md) |
| **CONFIGURE** | identity and running base URL known | routes, viewports, schemes, scenarios, safe interactions, authentication path, framework overrides, and `config.json` recorded | [runtime.md](references/runtime.md), [frameworks.md](references/frameworks.md) |
| **CAPTURE** | valid config and Node 20+ | `run.mjs` completed; `stack` ran first; requested artifacts and `lanes.json` exist, with degradations explicit | [runtime.md](references/runtime.md), [frameworks.md](references/frameworks.md) |
| **REVIEW** | capture artifacts available | every successful screenshot reviewed against only the `V` checks in loaded sections; measured artifacts mapped without lane substitution | [rules.md](references/rules.md), [report.md](references/report.md), [frameworks.md](references/frameworks.md) |
| **REPORT** | findings and gaps reconciled | `.specs/ux-audit/<run-id>/ux-audit-report.md` contains findings, full rule coverage, token proposal, and prioritized fix plan | [report.md](references/report.md) |
| **VERIFY** | report written | before/after status baseline compared; only allowed paths changed; user receives the report path, severity counts, and gaps | [runtime.md](references/runtime.md), [report.md](references/report.md) |

Phases are ordered. A lane failure degrades its coverage but does not cancel
independent lanes. Never stop to ask what the code can answer. Stop only for a missing
running base URL or required credential only the user can supply, an unsafe
target, or an integrity failure outside the write allowlist.

## Execution

`<skill-dir>` is the directory containing this `SKILL.md`. Node 20 or newer is
required. Run:

```text
node "<skill-dir>/scripts/run.mjs" --config "<target>/.specs/ux-audit/<run-id>/config.json" [--only <lanes>] [--install-browsers]
```

Available lanes are `stack`, `capture`, `axe`, `contrast`, `focus`, `targets`,
`forms`, `tokens`, `perf`, `motion`, `reflow`, `theme`, and `rtl`. `stack` runs
first whenever a requested lane consumes framework information.

Exit code `0` means all requested lanes completed, `3` means the run completed
with degraded lanes, and `2` means invalid usage or configuration. On `3`, keep
the usable artifacts, record each gap and remediation, and continue through the
report. On `2`, correct the configuration when evidence permits; otherwise ask
one precise question.

## Reporting and completion

The report owns the complete result. It must include the exact seven-column
finding table, severity-adjustment reasons, identity decisions, detected
frameworks, a rule-by-rule coverage matrix, stack-native token proposals, and
small prioritized tasks tagged `token-only`, `component restyle`, or `layout
change`. Findings authorize no fixes.

At completion, tell the user:

- the report's target-relative path and run ID;
- finding counts by Critical, High, Medium, and Low;
- the number of coverage gaps, grouped by lane, with their closing actions;
- whether the status baseline found any path outside the write allowlist;
- that the application and LOCKED identity items were not changed.

## References

| Reference | Load when |
|---|---|
| [rules.md](references/rules.md) | Selecting loaded sections, mapping evidence to rule IDs, and applying default severity. |
| [design-md.md](references/design-md.md) | Locating, validating, or deriving the identity contract from the code. |
| [runtime.md](references/runtime.md) | Preparing `config.json`, capturing evidence, handling authentication, readiness, themes, RTL, dependencies, and integrity. |
| [report.md](references/report.md) | Mapping artifacts, reviewing screenshots, calibrating severity, building coverage, and writing the final report. |
| [frameworks.md](references/frameworks.md) | Detecting styling frameworks, separating defaults from app decisions, judging scales, and phrasing native fixes. |

Repository instructions at the target outrank this skill. They do not expand
the write allowlist or authorize starting the application.
