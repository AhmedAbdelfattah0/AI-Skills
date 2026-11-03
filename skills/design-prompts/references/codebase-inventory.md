# Codebase inventory (redesigning an existing app)

When the product already exists in a repo and the user wants "go through every page and component", do NOT write prompts from memory or from route names. Read the code first, in parallel, and write inventories. Prompts written from inventories carry the real columns, fields, statuses, modals and states, which is what makes the design tool's output need zero structural fixes.

## Step 1: enumerate

- List every route/page file (e.g. `find apps/web/src/app -name page.tsx`) and group by area (public, auth, customer roles, staff roles, admin, super admin).
- Read the project's own context first: `CLAUDE.md` / `AGENTS.md`, `DESIGN.md` (brand contract, LOCKED vs FLEXIBLE), design-system docs, business-rule docs, decisions logs.

## Step 2: fan out inventory agents (one message, run in background)

Split so each agent handles roughly 10-30 pages. Always include one **design-system agent**. Each writes a markdown file to the scratchpad, never touches the repo.

### Page inventory agent prompt (adapt scope)

```
You are building a UI/business inventory for a redesign of {product} (repo root {path}).
Read {CLAUDE.md, domain docs} for business context. Do NOT modify any repo file.

Your scope: every page file under {dirs}, plus the layouts and components those pages
use ({list known shared components}). {Language/RTL note for this area.}

For EACH page (and each wizard step / major component), read the actual code and write:
- Route + audience/role
- Business purpose (what outcome or job it serves)
- Every section/block top to bottom with the real data shown (fields, columns, badges,
  statuses, prices)
- Every user action (buttons, forms + fields + validation, modals/drawers and their
  fields), and where it goes
- States the code handles: loading, empty, error, success, and domain states
  (expired, locked, conflict, declined, no permission…)
- Language/RTL and phone notes
- Current UI weaknesses and bugs you notice (brief)
- Components this page shares with pages outside your scope (pickers, tables, dialogs), so the app map can name one owner

Write markdown to {scratchpad}/inv-NN-{area}.md. Be thorough and concrete: precision
about fields and states matters more than prose. Reply with the path and page count.
```

### Design-system agent prompt

```
Read {DESIGN.md, design docs, tailwind/theme config, global CSS, every ui/ primitive,
the app shell + nav config + role switcher, brand assets, every status→colour map}.
Write a reference: exact colour tokens (hex), semantic tokens, fonts per surface and
language, radii, shadows, motion, button variants/sizes, modal/drawer behaviour, form
patterns, pill variants and EVERY status enum with its current colour on each page
(flag disagreements), KPI/empty/toast/table patterns, phone rules, NAV PER ROLE (every
group and link label), and a concrete list of why the current UI feels bland.
Write to {scratchpad}/inv-NN-design-system.md.
```

> **Steps 1-2 are Phase 0.** Stop here, return to Discovery (Phase 1) and get the plan confirmed (Phase 2). Steps 3-6 run inside Phases 3-5.

## Step 3: write 00, 01 and 02 yourself (Phase 3)

You own `00-Orientation.md`, `01-DESIGN.md` and `02-APP-MAP.md` (consistency and assembly live there). Use the design-system inventory: keep LOCKED brand items, express them with more confidence, fix status-colour disagreements with one STATUS map, name the blandness causes so the redesign answers them. Build the app map from Step 1's routes: every route becomes a screen key in one product, and every component shared across areas gets one owner.

## Step 4: fan out prompt writers with one shared brief (Phase 4)

Write `{scratchpad}/WRITER-BRIEF.md` (template: [writer-brief](writer-brief.md)), then spawn one writer per 1-3 prompts, each pointed at: the brief, 00, 01, 02, its inventory file(s), and the user's reference design if they gave one. Writers only write their assigned prompt files.

## Step 5: verify the set (you, not the writers; end of Phase 4)

1. **Route coverage:** every route from Step 1 is a screen key in `02-APP-MAP.md`, and every screen key is owned by exactly one brief; list any gap and place it.
2. **Duplicates:** the same screen designed in two prompts (e.g. pay-by-link in both Auth and Checkout). Keep it where it fits the shared component (all payment outcomes together); the other prompt links to it by screen key.
3. **Handshake chain:** every prompt's "After delivery, reply" names the next prompt; headers say "Run AFTER prompt N-1".
4. **Consistency with 00-02:** every brief has a Binding block, uses the adapter header, and restates no design-system values.
5. **Cross-section reuse:** a section that shows screens or components owned elsewhere mounts or imports them by name and owner, never re-creates them ([verification-protocol](verification-protocol.md) §3).
6. **Copy rules** from the project (e.g. no em dashes) grep-checked.
7. **Writer-flagged proposals** collected into the README's "Decisions for the PO", and present in briefs only under Proposals.
8. **Assets the tool cannot fetch** (self-hosted fonts, logos): tell the user to upload them to the container.

## Step 6: deliver (Phase 5)

Save to the repo at `docs/design-prompts/` (or where the user says), with a `README.md`: how to run (open one container, paste 00, then in order into it; part-2 prompts extend part 1), or, with no adapter, that the set is a plan not yet ready to paste (SKILL.md Phase 5); the tool and adapter with its tested status, the prompt/section/language table, design direction in bullets, "Decisions for the PO" grouped (brand and type · proposals that change behaviour · placeholder content · not built yet), and asset uploads needed. Mention bugs the inventory found as a short side list for the user; they are not part of the prompts.
