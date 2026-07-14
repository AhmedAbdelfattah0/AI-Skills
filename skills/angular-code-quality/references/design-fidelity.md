# Design Fidelity — Reference

Loaded when a task changes UI. The gate is STEP 1B of the skill; this file is the how.

The failure this prevents: *"there's a design reference"* is worthless if the implementer never
opens it. **Available ≠ consulted.** Style drift, column collisions, and clipped controls almost
always trace back to a hand-rolled component that a shared one already covered.

---

## 1. Locate the design system yourself

Do not depend on the ticket naming it. Search in this order:

```bash
# tokens / theme — the most important file, the most often skipped
find . -path ./node_modules -prune -o \
  \( -iname "tokens*" -o -iname "theme*" -o -iname "*design-token*" -o -iname "_variables*" \) -print

# a design directory or a Claude Design set
ls -d design design-files .design 2>/dev/null
find . -path ./node_modules -prune -o -name "*.dc.html" -print

# an orientation / conventions doc
find . -path ./node_modules -prune -o -iname "*master-orientation*" -o -iname "*design-system*.md" -print

# the shared component inventory
ls src/app/shared/components 2>/dev/null
```

The design reference is not one file and not one format. It may be a Claude Design set
(`*.dc.html`), a self-contained HTML showcase (pages as `<section>` blocks), component files
(`.jsx / .tsx / .vue`), or a mix.

**If UI is in scope and nothing turns up → ✋ STOP and ask the user where the design lives.**
Do not invent a visual language.

---

## 2. Read three things, in this order

1. **Token / theme file.** Single source of color, spacing, type, radius, elevation.
2. **Conventions / orientation doc**, if one exists. Brand rules, bilingual/RTL rules,
   numeric-isolation rules, component inventory.
3. **The referenced screen AND the shared components it composes** — its table, form, drawer,
   pagination, badge, field renderer. The screen alone is not enough; you need the parts.

Record which files you opened. After a `/compact`, the fidelity decision must stay auditable.

---

## 3. Build by composition, not approximation

"Reimplement in Angular" means **reuse the existing components** and supply columns, rows, and
field configs. It does not mean hand-rolling equivalents from raw markup.

| Instead of | Compose |
|---|---|
| `<table>` + `<tr>` loops | the shared table, given a column config |
| `<input>` + manual label/error markup | the shared input (it implements `ControlValueAccessor`) |
| a `<div>` overlay with a backdrop | the shared drawer / modal |
| page-number buttons in a `*ngFor` | the shared pager |

---

## 4. Zero hardcoded color (`NG-UI-02`, `[NN]`)

Color, spacing, type, and radius come from tokens. Nothing else. Lint-enforce it where possible;
otherwise grep:

```bash
grep -rniE "#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(" src/app --include=*.scss --include=*.html
```

Hits in a token file are expected. Hits anywhere else are findings.

---

## 5. Bilingual / RTL (`NG-UI-03`)

- Use **logical properties** throughout: `padding-inline-start`, `margin-inline-end`,
  `inset-inline-start`, `text-align: start`. Never `padding-left`, `margin-right`, `left`.
- Isolate numbers, IDs, dates, prices, and store numbers **LTR inside RTL text**:
  `<span dir="ltr">…</span>`.
- Never mix LTR and RTL on the same line. Keep each language on its own line in mixed content.
- The language toggle flips both `document.documentElement.lang` and `…dir`.

---

## 6. Deficient-reference carve-out

If a shared design component is **itself defective** — a paginator that renders every page number
with no windowing, an input that swallows its error state — fixing the component at its source
takes precedence over literal fidelity.

Fix it. Note it. Flag it to the user. Do **not** faithfully reproduce a known defect, and do not
work around it locally in your screen — that forks the component.

---

## 7. Self-check before review

- [ ] The screen composes shared components; nothing hand-rolled that already exists
- [ ] No hardcoded color/spacing/type/radius outside the token file
- [ ] Logical CSS properties throughout; numbers stay LTR inside RTL
- [ ] Any component defect found was fixed at source and flagged, not reproduced
- [ ] You can name the token file and the component files you opened
