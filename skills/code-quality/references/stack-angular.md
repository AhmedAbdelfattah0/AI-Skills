# Angular stack rules (NG-*)

Loaded from `code-quality` (`../SKILL.md` LOAD TABLE) for Angular work. Rule
Tiers, STEP 0, the STEP 0B gate, STEP 0C steps 1–3 and the shared Verification
Pass rules are in `../SKILL.md`. Step numbers are the original ones, so
cross-references hold.

Enforced Angular/MVVM/Signals review with stable rule IDs, a Design Contract
gate, and an evidence-backed Verification Pass — nothing ships unproven.

Design principles here are **enforced, not suggested**. Every rule has a stable ID. Nothing
gets written until it has been assigned a layer and a rule set (STEP 0B), and nothing is
called done until every in-force rule reports PASS or NOT_APPLICABLE with evidence (STEP 8).

Deviation is never silent. If a rule cannot be followed, you **stop and surface it** — you
do not implement the deviation and explain afterwards.

---

## STEP 0A — Read Context, Persist a Profile

```bash
cat CLAUDE.md 2>/dev/null || echo "NO_CLAUDE_MD"
cat .claude/angular-code-quality/profile.md 2>/dev/null || echo "NO_PROFILE_CACHED"
```

**If a profile is cached:** use it. Skip discovery.

**If `CLAUDE.md` exists:** extract selector prefix, folder structure, design system / shared
component library, auth strategy, HTTP interceptors, deploy target, and any explicit overrides.

**If neither exists:** apply this skill's defaults, ask the one question you cannot infer —

> "What's the component selector prefix, and where does the design system live?"

— then write the profile. Stage multiline content to a temp file; bash argument passing
collapses newlines.

```bash
mkdir -p .claude/angular-code-quality
cat > /tmp/acq-profile.md <<'PROFILE'
# Angular Code Quality — Resolved Profile
selector_prefix:     # e.g. pf- | ikea- | asis-
angular_version:     # e.g. 19
structure:           # path convention, or "skill default"
design_system:       # e.g. SKAPA | Tailwind v4 | custom; where tokens live
shared_components:   # inventory path, e.g. src/app/shared/components
api_layer:           # e.g. core/services/api.service.ts
i18n:                # e.g. EN/AR, RTL required | none
state:               # e.g. Signals only | Signals + limited RxJS
PROFILE
mv /tmp/acq-profile.md .claude/angular-code-quality/profile.md
echo "Profile cached at .claude/angular-code-quality/profile.md"
```

> ✋ **STOP** — fill the profile from the real project before writing it. Do not cache empty
> placeholders, and do not generate code until the profile reflects reality.

---

## STEP 0B — Angular contract shape

```
DESIGN CONTRACT
Task: <one line>

| File | MVVM role | Single responsibility (one sentence) | Depends on | Rules in force |
|---|---|---|---|---|
| features/x/services/x-state.service.ts | ViewModel | Owns wizard step state | — | NG-ARCH-02,06 · NG-SOLID-01 |
| features/x/components/y/y.component.ts  | View      | Renders step 1              | XStateService | NG-ARCH-03,05 · NG-STD-01,02 |

Deviations requested: none
```

Rules for the contract:
- If a responsibility sentence needs the word **"and"**, the file is doing two things. Split it
  before proceeding (`NG-SOLID-01`).
- If you cannot assign a role, the file does not belong in this architecture. Stop and ask.
- If a `Deviations requested` line is non-empty → **✋ STOP** and run the Deviation Protocol.
- If the task touches UI → the contract is invalid until STEP 1B has been completed.


## STEP 0C — Angular waiver ledger

4. If waived, record it — a waiver that isn't written down is a rule that quietly died:

```bash
mkdir -p .claude/angular-code-quality
cat > /tmp/acq-dev.md <<'DEV'

## <YYYY-MM-DD> · <RULE-ID>
scope:     <file path + symbol>
reason:    <why the rule cannot hold here>
risk:      <what this costs us>
expires:   <condition that removes this waiver, or a date>
DEV
cat /tmp/acq-dev.md >> .claude/angular-code-quality/deviations.md
rm /tmp/acq-dev.md
```

Never acceptable, and never a deviation you may take unilaterally:
- `// TODO: refactor later` in place of following the rule
- A second pattern for a concern that already has one
- "It's simpler this way" / "it's just a prototype" / "only one component does this"

---

## STEP 1 — Resolve File Placement

`NG-ARCH-01` `[ARCH]` — Placement is resolved **before** a file is created, from `CLAUDE.md`
or the profile. Absent both, use this default:

```
src/app/
├── core/          ← app-wide singletons (guards, interceptors, api service)
├── features/      ← one folder per feature
│   └── {feature}/
│       ├── components/   ← dumb UI (View)
│       ├── models/       ← interfaces + types (Model)
│       ├── services/     ← state + business logic (ViewModel)
│       └── pages/        ← routed shells
└── shared/        ← reused across 2+ features
    ├── components/
    ├── models/
    ├── pipes/
    └── services/
```

- Feature component → `features/{feature}/components/`
- Routed page → `features/{feature}/pages/`
- State/logic service → `features/{feature}/services/`
- Interface/type → `features/{feature}/models/`
- Used in 2+ features → `shared/`
- App-wide singleton → `core/`

`NG-ARCH-07` `[ARCH]` — **Reuse before create.** Inventory `shared/components/` first. A
hand-rolled table, input, drawer, or pager where a shared one exists is drift, not a shortcut.

---

## STEP 1B — Design Source of Truth (hard gate, UI tickets only)

For any task that produces or changes UI, **open the design files before writing frontend
code.** Available ≠ consulted. Read, in this order:

1. **The token / theme file** — the single source of color, spacing, type, radius, elevation.
   Most important, most often skipped.
2. **The conventions / orientation doc**, if one exists — brand rules, RTL/bilingual rules,
   numeric-isolation rules, component inventory.
3. **The referenced screen AND the shared components it composes** — its table, form, drawer,
   pagination, field renderer.

Self-locate. If the ticket doesn't name the design files, search the repo. If UI is in scope
and no design system exists anywhere → **✋ STOP and ask.** Never invent a visual language.

- `NG-UI-01` `[ARCH]` — **Compose the shared components.** Supply columns / rows / field
  configs. Do not hand-roll equivalents from raw markup.
- `NG-UI-02` `[NN]` — **Zero hardcoded color** outside the token file. Color, spacing, type,
  and radius come from tokens. Lint-enforce it where you can.
- `NG-UI-03` `[ARCH]` — Honor bilingual/RTL conventions; isolate numbers, IDs, dates, prices,
  and store numbers LTR inside RTL text.
- **Deficient-reference carve-out:** if a shared component is itself defective (e.g. a paginator
  with no windowing), fix it at source and flag it. Do not faithfully reproduce a known defect.

If challenged later on why the UI matches the design, you should be able to name the token file
and the component files you opened here.

---

## STEP 2 — MVVM Roles

| Role | File | Responsibility |
|---|---|---|
| Model | `*.model.ts`, `*.interface.ts` | Data shape only — no logic |
| ViewModel | `*.service.ts` | Signals, computed, business logic, HTTP orchestration |
| View | `*.component.ts` + `.html` | Render only — binds to the ViewModel |

- `NG-ARCH-02` `[ARCH]` — Every file has **exactly one** role. A file with two roles is split.
- `NG-ARCH-03` `[ARCH]` — No business logic, no `computed`, no getters-that-calculate in a
  component. Derived state lives in the ViewModel.
- `NG-ARCH-04` `[ARCH]` — `HttpClient` is injected **only** by the central `ApiService`. Feature
  services call `ApiService`; components call feature services. Components never call HTTP.
- `NG-ARCH-05` `[ARCH]` — No state signals declared in a component. Local *UI-only* concerns
  (an open/closed flag, a form instance) are permitted; anything another file could read is state.
- `NG-ARCH-06` `[ARCH]` — Services expose signals via `.asReadonly()`. Writable signals stay private.
- `NG-ARCH-08` `[D]` — No `async` pipe where a signal is available.

---

## STEP 3 — Angular Rules

**Signals**
- `NG-STD-07` `[D]` — State → `signal<T>()`; derived → `computed()`; side effects → `effect()`
  only. Convert Observables with `toSignal()`. Never `BehaviorSubject` where a signal works.

**Subscriptions (where RxJS is genuinely needed)**
- `NG-CORE-02` `[NN]` — Every subscription is cleaned up: `takeUntilDestroyed()`, or
  `takeUntil(this.ngUnSubscribe)` as the **last** operator. A naked `.subscribe()` is a leak.

**Components**
- `NG-STD-01` `[D]` — `standalone: true`
- `NG-STD-02` `[D]` — `changeDetection: ChangeDetectionStrategy.OnPush`
- `NG-STD-03` `[D]` — `inject()` over constructor injection
- `NG-STD-04` `[D]` — Selector prefix from the profile
- `NG-STD-05` `[D]` — Separate template + style files for non-trivial components
- `NG-CORE-01` `[NN]` — Never `any`. No untyped escape hatch where a real type fits.
- `NG-CORE-03` `[NN]` — No `console.log` committed.

**Forms — pick by complexity, never by convenience**
- `NG-STD-06` `[D]` — **Reactive forms** (typed `FormGroup` + `Validators`) for any form with
  validation, cross-field rules, conditional/dynamic fields, or async submission: checkout, auth,
  all admin editors. **Signal two-way binding** (`[(ngModel)]` / `model()`) for simple
  single-value inputs with no validation graph: header search, one filter, a toggle, a sort
  dropdown. Shared design-system controls implement `ControlValueAccessor` so both work.
- Do **not** mass-convert trivial inputs to `FormGroup`. Do **not** hand-roll validation via
  `computed` gating on a form that should be reactive.
- `[(ngModel)]` bound to a `WritableSignal` is **valid** (Angular 17.2+). It is not an error. A
  review finding that says otherwise conflicts with this rule — skip it and note why.

**NG0100**
- `NG-STD-08` `[D]` — `queueMicrotask(() => { … })` only when NG0100 actually occurs, always with
  the comment `// queueMicrotask — prevents NG0100 on [reason]`.

---

## STEP 4 — Security & Output Safety

All `[NN]`. These do not bend for prototypes.

- `NG-SEC-01` — Never bind untrusted or remote data into `[innerHTML]`. Interpolation `{{ }}`
  escapes by default — keep rendering through it.
- `NG-SEC-02` — Never call `DomSanitizer.bypassSecurityTrust*()` on any value derived from user
  input, an API response, or the URL. Bypass is for values you fully control. If dynamic HTML
  from a trusted source is unavoidable, use `DomSanitizer.sanitize(SecurityContext.HTML, value)`
  — sanitize, don't bypass.
- `NG-SEC-03` — Nothing secret ships to the browser: no API keys, tokens, internal hostnames, or
  internal IPs in `environment*.ts` or anything bundled. Environment files are public after build.
- `NG-SEC-04` — CSP-compatible: no inline event handlers, no `<script>` injected via string HTML,
  no `eval`, no `new Function`, no dynamically created script tags. A strict `script-src 'self'`
  must not break the app.
- `NG-SEC-05` — Do not hash or encrypt passwords client-side as a "security" measure. Client-side
  crypto just makes the hash the new password. HTTPS in transit, server-side KDF at rest.
- `NG-SEC-06` — Bound inputs: `maxlength` on text inputs, caps on array/file sizes. This is UX
  plus a first DoS guard, **not** the control. Real enforcement is server-side.

**Dependency currency — calibrate before acting** (`NG-STD-09` `[D]`)
Keep Angular on a *supported* release, but check the real support window and advisories before
flagging a version. "Not the latest" ≠ "vulnerable". Patch within the current major first
(`ng update @angular/core @angular/cli`); plan the major hop before EOL, not reactively.

---

## STEP 5 — SOLID

| ID | Tier | Rule |
|---|---|---|
| `NG-SOLID-01` | `[ARCH]` | **S** — One service, one responsibility. Split: state / HTTP / download / persistence. If the responsibility sentence needs "and", split it. |
| `NG-SOLID-02` | `[ARCH]` | **O** — New strategies (deploy target, payment gateway, market) are new classes. Not `if` branches inside working code. |
| `NG-SOLID-03` | `[ARCH]` | **L** — Subtypes are substitutable. No `instanceof` type-checking in services. |
| `NG-SOLID-04` | `[ARCH]` | **I** — Small focused interfaces (`Nameable`, `Codeable`, `Toggleable`), not one fat interface. |
| `NG-SOLID-05` | `[ARCH]` | **D** — Inject abstractions (abstract class / token), not concrete implementations. |

---


## STEP 8 — Verification Pass (hard gate)

Angular rows for the shared Verification Pass in `../SKILL.md`.

```
VERIFICATION
| Subject ID | Outcome | Evidence |
|---|---|---|
| NG-ARCH-03 | PASS | no computed/getters in step-one.component.ts |
| NG-ARCH-04 | PASS | HttpClient only in core/services/api.service.ts:14 |
| NG-UI-02   | PASS | all colors via var(--…); grep found 0 hex literals |
| NG-CORE-02 | NOT_APPLICABLE | no subscriptions introduced |
| NG-STD-06  | PASS | reactive — form has cross-field validation |
```

- Only list rules **in force** for this task — the ones named in the Design Contract, plus every
  `[NN]` rule, which is always in force.
- **One `TEST` row is in force whenever the diff includes `*.spec.ts` / `*.test.ts`**: walk
  TEST-01..12 from the `test-quality` skill against the test diff —
  `TEST | PASS | mocks only at HttpClient boundary; no near-duplicate bodies; no toBeTruthy()-only tests`
  — or FAIL naming the ID. A must-fix violation (TEST-01/02/08) blocks done like any FAIL.
- **One `DOC` row is in force whenever the diff touches docs surfaces** (`*.md`, docstrings,
  JSDoc): walk DOC-01..10 from the `docs-accuracy` skill — every referenced symbol verified
  against its definition; renamed symbols grepped across doc surfaces —
  `DOC | PASS | 12 claims checked, 0 false; old selector name grepped, absent` — or FAIL
  naming the ID. Must-fix violations (DOC-01..04: false claims) block done.

Fast mechanical checks:

```bash
grep -rn "HttpClient" src/app --include=*.component.ts && echo "FAIL NG-ARCH-04" || echo "PASS NG-ARCH-04"
grep -rn ": any\|<any>" src/app --include=*.ts && echo "FAIL NG-CORE-01" || echo "PASS NG-CORE-01"
grep -rn "console.log" src/app --include=*.ts && echo "FAIL NG-CORE-03" || echo "PASS NG-CORE-03"
grep -rn "bypassSecurityTrust" src/app --include=*.ts && echo "REVIEW NG-SEC-02" || echo "PASS NG-SEC-02"
grep -rniE "#[0-9a-f]{3,8}\b|rgba?\(" src/app --include=*.scss && echo "REVIEW NG-UI-02" || echo "PASS NG-UI-02"
```

---

## Reference Files

Load only when the task needs them.

| File | Load when |
|---|---|
| `angular-profile-template.md` | No CLAUDE.md exists — scaffold one for the project |
| `angular-design-fidelity.md` | A UI task where the design system must be located and composed |
| `../../test-quality/references/jest-vitest.md` | The diff includes `*.spec.ts`/`*.test.ts` — TEST-01..12 concretized for Jest/Vitest/Angular (shared with the `test-quality` skill; if absent, walk from its summary: assert behavior not internals, mock only at the HttpClient/SDK boundary, real objects not MagicMocks, parametrize value-only variants, no framework-guarantee or toBeTruthy()-only tests, regression tests are sacred) |

## Success criteria

Working when: every task ships with a Design Contract before code and a
Verification Pass with evidence after; no file exists outside the contract;
deviations carry rule IDs and ledger entries; the AI-FM/TEST/DOC rows appear
whenever their trigger files are in the diff.

## Troubleshooting

- **A rule blocks a legitimate pattern:** run the Deviation Protocol (STEP 0C) —
  cite the rule ID, record the waiver with a `expires:` trigger; never skip silently.
