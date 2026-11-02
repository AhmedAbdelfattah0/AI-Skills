# WRITER-BRIEF template (for delegating section briefs)

Copy to the scratchpad, fill the `{…}`, and point every writer agent at it.

```markdown
# Brief for writing {Project} section prompts

Repo: {path}. Do NOT modify any file outside {prompts dir}. Write only the prompt files assigned to you.

READ FIRST (fully):
1. {prompts dir}/00-Orientation.md (context, gates, tool rules, language rules)
2. {prompts dir}/01-DESIGN.md (the design system: components, tokens, STATUS map, approved variants, chosen motion). Use it by NAME; never restate its values or invent a look for your section.
3. {prompts dir}/02-APP-MAP.md (the assembled product: screen keys, layouts, links, shared components and their owners, shared journeys, prompt batches).
4. {skill path}/references/core-contract.md (the two gates and the Binding block) and {skill path}/references/{adapter file} (how this tool builds it).
5. Your source of truth. Existing app: your inventory file(s) in the scratchpad. New product: the approved Discovery answers and spec ({path or pasted spec}).

WHAT A PROMPT FILE MUST CONTAIN (in this order):
1. Title "# Prompt NN of {M} — <Section>" and the adapter header (from the adapter file) plus "Run AFTER prompt NN-1".
2. ## Binding: filled from 02-APP-MAP.md (container, design system, the screen keys this prompt owns, what it extends, links out, shared components used and created, do not touch).
3. ## Recap: task context in 3-5 lines (product, this section's users and jobs). No design-system values.
4. ## Section identity: who, jobs, which approved variant from 01-DESIGN.md applies (or "default"). Never a new visual tone.
5. ## Files or artboards to deliver: per the adapter, each with the screen keys it holds. Part 2: only new files + exact edits.
6. ## Complete screen list: every screen key this prompt owns, grouped; auxiliary screens (404, no access, error) if the map assigns them here. Nothing from your source of truth dropped.
7. ## Key screen details: for EVERY screen: one-line purpose, sections top to bottom with real fields/columns, filters, KPIs, every modal/drawer/wizard step with fields and validation, actions, links (screen keys), and states (loading, empty, error + domain states). Say WHAT, not pixels. Use shared components by name with their owner.
   - Existing app only: design the INTENDED behaviour; inventory bugs (wrong timezone, wrong label, hover-only actions, browser prompt() boxes) become requirements for the correct version.
8. ## Mock data: what this section's data holds, realistic for the market, sized to look real.
9. ## Translation glossary (multi-language sections only, 25-40 rows per extra locale in this section's voice); a single-language section states its language and direction instead ({primary language, ltr|rtl} from Discovery).
10. ## Visual and UX requirements: phone behaviour, tables to cards, sheets, tap targets, RTL mirroring, shortcuts. Then ## Motion: for each component type in this section, the behaviour chosen in 01-DESIGN.md (by name), and any section-specific exception with its reason. Never write only "smooth" or "animated".
11. ## Proposals (not to build yet): anything new you would add; the tool must not build these.
12. ## Deliverable: per the adapter, "deliver only these files", the adapter's verification lines, and the G1/G2 checks from verification-protocol.md §1.
13. Handshake: 'After delivery, reply: "<Section> complete. Ready for prompt NN+1 (<next>)."'

DEPTH: meet {skill path}/references/depth-standard.md and run its §4 self-check on your files before replying.

MOTION: meet {skill path}/references/motion-and-finish.md (§1 required outcomes, the behaviours 01-DESIGN.md selected) and run its §6 self-check before replying.

STYLE: {project copy rules, e.g. no em dashes in UI copy}. Completeness over brevity: a 15-screen section is typically 400-900 lines.

NUMBERING (whole set, for handshakes):
{00 … M with section names}

When done, reply with the file paths, the screen keys each covers, any source page you could not place, any shared component you needed that the map does not list, and every proposal you added.
```
