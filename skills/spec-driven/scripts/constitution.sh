#!/usr/bin/env bash
# spec-driven/scripts/constitution.sh
# Usage: constitution.sh "<PROJECT_NAME>" "<PROJECT_TYPE>" "<UI_FRAMEWORK>" "<SELECTOR_PREFIX>" "<MARKETS>" "<RTL>"
#
# TEMPLATE (fallback if script not found):
# ---
# # [PROJECT_NAME] — Architectural Constitution
# > Ratified: [DATE]
# ## Project Identity
# | Project Name | [PROJECT_NAME] |
# | Project Type | [PROJECT_TYPE] |
# | UI Framework | [UI_FRAMEWORK] |
# | Selector Prefix | [SELECTOR_PREFIX] |
# | Markets | [MARKETS] |
# | RTL | [RTL] |
# ## Principles I–VIII (see script body below)

PROJECT_NAME="${1}"
PROJECT_TYPE="${2}"   # ikea | personal
UI_FRAMEWORK="${3}"   # skapa | tailwind
SELECTOR_PREFIX="${4}"
MARKETS="${5}"
RTL="${6}"            # yes | no

SPEC_DIR=".spec"
OUT="$SPEC_DIR/constitution.md"
DATE=$(date "+%Y-%m-%d")

mkdir -p "$SPEC_DIR"

# Build UI principle based on project type
if [ "$PROJECT_TYPE" = "ikea" ]; then
  UI_PRINCIPLE="Use SKAPA components exclusively (\`@ingka/button\`, \`@ingka/ssr-icon\`, \`@ingka/modal\`, etc.).
No custom CSS classes. No Tailwind. No inline styles.
Match IKEA design language: spacing tokens, type scale, and color palette from SKAPA only."
else
  UI_PRINCIPLE="Use Tailwind CSS v4 utility classes exclusively.
Follow project design tokens in \`styles.scss\` (primary, navy, accent, etc.).
No inline styles. No arbitrary values like \`w-[347px]\` without justification.
Spacing: stick to Tailwind scale (p-4, p-6, gap-4, gap-6). Responsive: mobile-first."
fi

# Build RTL principle
if [ "$RTL" = "yes" ]; then
  RTL_PRINCIPLE="All layouts use logical CSS properties: \`margin-inline-start\` not \`margin-left\`.
\`dir=\"rtl\"\` is set at document root for AR locale.
Test every UI component in both LTR (EN) and RTL (AR) before marking done."
else
  RTL_PRINCIPLE="Single locale. RTL not required."
fi

cat > "$OUT" << CONSTITUTION
# ${PROJECT_NAME} — Architectural Constitution
> Ratified: ${DATE}

---

## Project Identity

| Field | Value |
|---|---|
| **Project Name** | ${PROJECT_NAME} |
| **Project Type** | ${PROJECT_TYPE} |
| **UI Framework** | ${UI_FRAMEWORK} |
| **Selector Prefix** | \`${SELECTOR_PREFIX}\` |
| **Markets** | ${MARKETS} |
| **RTL** | ${RTL} |
| **Angular Pattern** | MVVM — Services are ViewModels, Components are Views |
| **State Management** | Angular Signals only (no NgRx, no BehaviorSubject) |

---

## Principle I — Component Architecture

All components are:
- \`standalone: true\`
- \`changeDetection: ChangeDetectionStrategy.OnPush\`
- Prefixed with \`${SELECTOR_PREFIX}\`
- Dumb (no business logic, no HttpClient, no state signals)
- Injecting ViewModel services via \`inject()\` only

Services own all state via private \`signal<T>()\` exposed as \`.asReadonly()\`.
Computed values live in services — never as component getters.

---

## Principle II — SOLID Enforcement

- **S**: Each service has exactly one responsibility
- **O**: New behavior via new classes/files — never editing stable working code
- **I**: Interfaces are small and composable (\`Nameable\`, \`Codeable\`, \`Toggleable\`)
- **D**: Services depend on abstractions — concrete implementations via DI

---

## Principle III — SSR Safety

All browser API access is guarded:
\`\`\`typescript
import { isPlatformBrowser } from '@angular/common';
const isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
if (isBrowser) { /* localStorage, window, document */ }
\`\`\`

---

## Principle IV — Design Fidelity

${UI_PRINCIPLE}

---

## Principle V — Data Normalization

API responses are normalized at the service boundary — never in components.
Repository services return typed models; they never expose raw API shapes.

---

## Principle VI — YAGNI

Build exactly what the spec requires.
No speculative abstractions. Add flexibility only when a second concrete use case exists.

---

## Principle VII — RTL Support

${RTL_PRINCIPLE}

---

## Principle VIII — Performance

- Lazy-load all feature modules via Angular Router
- \`trackBy\` on all \`@for\` loops
- Heavy computations use \`computed()\` — not re-evaluated unless dependencies change
- No synchronous heavy operations in component lifecycle hooks

---

## Amendment Log

| Date | Change | Author |
|---|---|---|
| ${DATE} | Initial ratification | — |
CONSTITUTION

echo "✅ Constitution written to ${OUT}"
