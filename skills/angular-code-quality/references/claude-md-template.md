# CLAUDE.md — Frontend (Angular)

> Scaffold produced by the `angular-code-quality` skill. Fill every TODO, delete this line.
> This file is the source of truth. The skill defers to it over its own `[D]` defaults, and
> may override its `[ARCH]` rules **project-wide** — but never file-by-file.
>
> It cannot override `[NN]` rules. Those are security and correctness invariants.

## Stack

- Angular version: TODO (e.g. 19)
- State: TODO (Signals only / Signals + limited RxJS / NgRx)
- Styling: TODO (Tailwind v4 / SCSS + design tokens / design system name)
- Forms: TODO (reactive by default; signal binding for simple inputs)
- i18n: TODO (languages; RTL required? y/n)
- Build/deploy target: TODO (Azure SWA / Cloudflare Pages / S3 / …)

## Conventions

- **Selector prefix:** TODO (e.g. `pf-`, `ikea-`)
- **Folder structure:** TODO — confirm or replace the skill default:
  `core/` (singletons) · `features/{feature}/{components,models,services,pages}` · `shared/`
- **HTTP:** TODO — path to the central `ApiService`. Nothing else injects `HttpClient`.
- **Auth strategy:** TODO (session / JWT / SSO provider); guards live in `core/guards`
- **Interceptors:** TODO (auth, error, correlation-id — and their order)
- **Base component:** TODO — does one exist, and does it own `ngUnSubscribe`?

## Design system (required if this project has UI)

- **Token / theme file:** TODO — the single source of color, spacing, type, radius, elevation
- **Conventions / orientation doc:** TODO (brand rules, RTL rules, numeric isolation) or "none"
- **Shared component inventory:** TODO — path, plus the components that already exist:
  - `TODO-button`, `TODO-input`, `TODO-table`, `TODO-drawer`, `TODO-pager`, …

Anything in this inventory is **composed, never re-implemented** (`NG-UI-01`).
Color, spacing, type, and radius come from the token file only (`NG-UI-02`).

## Architectural overrides

> Use this section to replace an `[ARCH]` rule across the whole project. Leave empty if none.
> A rule listed here is replaced everywhere; it is never skipped in a single file.

- TODO or "none"

## Testing

- Runner: TODO (Vitest / Jest / Karma)
- Required coverage for: TODO (services always; components with logic; guards; interceptors)

## Things the skill should NOT flag

> Project-specific decisions that look like violations but are intentional. Be precise —
> this section suppresses findings, so a vague entry suppresses too much.

- `[(ngModel)]` bound to a `WritableSignal` is valid (Angular 17.2+) and intentional for simple
  single-value inputs. It is not a reactive-forms violation.
- TODO — add others as they come up
