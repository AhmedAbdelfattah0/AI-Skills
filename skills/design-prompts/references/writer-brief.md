# WRITER-BRIEF template (for delegating surface prompts)

Copy to the scratchpad, fill the `{…}`, and point every writer agent at it.

```markdown
# Brief for writing {Project} Claude Design prompts

Repo: {path}. Do NOT modify any file outside {prompts dir}. Write only the prompt files assigned to you.

READ FIRST (fully):
1. {prompts dir}/00-Master-Orientation.md (context, brand, moods, language rules, OUTPUT FORMAT)
2. {prompts dir}/01-Foundation….md (tokens, component library, STATUS map). Surface prompts reuse these components by name.
3. Your source of truth. Existing app: your inventory file(s) in the scratchpad, which describe every page from the real code. New product: the approved Discovery answers and page/feature spec for your surfaces ({path or pasted spec}).
4. Format reference (the user's most successful Claude Design output, if any): {path to reference folder, which files to skim}.

WHAT A PROMPT FILE MUST CONTAIN (in this order):
FORMAT: {component | html-showcase}. The items below are written for the component format. For html-showcase: "Produces ONE file: `{Project}-<X>.html`", no Foundation copy (tokens and components inline, restated from the Master), pages are `<section id="page-*">` blocks, and item 4 is just the filename.

1. Title "# Prompt NN of {M} — <Surface>" and "> Run AFTER prompt NN-1. Produces ONE folder: `{Project}-<X>/`" (part-2 prompts: "Extends the existing folder … Do not regenerate it.")
2. A self-contained recap (5-8 lines): product, brand essentials, this surface's mood, and "copy tokens.css, styles.css, icons.jsx, components-core.jsx from {Project}-Foundation unchanged; surface styles in styles-<surface>.css".
3. ## Surface identity: who, jobs, feeling.
4. ## Files to deliver: exact tree; pages-N.jsx each with the page keys it holds. Part 2: only NEW files + exact edits to existing files.
5. ## Shell: nav groups and every link with an icon, top bar, switchers/banners, phone behaviour, review tools (launcher or demo strip and its controls).
6. ## Complete page list: every route as a page key, grouped; auxiliary pages (404, no access, error). Nothing from your source of truth dropped.
7. ## Key page details: for EVERY page: one-line purpose, sections top to bottom with real fields/columns, filters, KPIs, every modal/drawer/wizard step with fields and validation, actions, and states (loading, empty, error + domain states). Say WHAT, not pixels. Modern patterns welcome (sparkline KPIs, command palette, list/detail split, bottom sheets, timelines, steppers); never invent business features your source of truth doesn't support.
   - Existing app only: design the INTENDED behaviour; inventory bugs (wrong timezone, wrong label, hover-only actions, browser prompt() boxes) become requirements for the correct version.
   - Anything genuinely new is marked "Proposal for PO approval".
8. ## Mock data: what data.js holds, realistic for the market, sized to look real.
9. ## Translation glossary (multi-language surfaces only, 25-40 rows per extra locale in this surface's voice); a single-language surface states its language and direction instead ({primary language, ltr|rtl} from Discovery).
10. ## Visual and UX requirements: phone behaviour, tables to cards, sheets, tap targets, RTL mirroring, shortcuts, reduced motion.
11. ## Deliverable: folder, "deliver only these files", verification checklist.
12. Handshake: 'After delivery, reply: "<Surface> complete. Ready for prompt NN+1 (<next>)."'

DEPTH: meet {path}/references/depth-standard.md (minimum per page, weak vs strong, proportions) and run its §4 self-check on your files before replying.

STYLE: {project copy rules, e.g. no em dashes in UI copy}. Completeness over brevity: a 15-page surface is typically 400-900 lines.

NUMBERING AND FOLDERS (whole set, for handshakes):
{00 … M with folder names}

When done, reply with the file paths, the page keys each covers, any source page you could not place, and any proposals or behaviour changes you introduced.
```
