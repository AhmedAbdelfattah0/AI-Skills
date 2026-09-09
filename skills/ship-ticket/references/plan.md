# PLAN — the template, the metadata, and the Design Contract

Loaded when the PLAN phase starts. The critique dispatch lives in
[codex-cli.md](codex-cli.md).

Planning is strong-model work: this is where deciding *what to build and how to
sequence it* actually happens. The plan is also the handoff that makes model
tiering real — strong plans, medium builds from the plan. Review passes are
excluded from tiering; they run at constant effort.

## The template

Use it exactly — same headings, same order, so every plan reads the same way.

```markdown
# Plan — <TICKET>: <ticket title>

<!-- the YAML header above this body carries:
     approval_status: pending|approved   a human approval flips this, and only this
     design_ref: <SHA>                   the pin
     ui_required: <bool>                 contract owns a screen OR diff touches the view layer
     mutation_round: 0                   the global budget; never auto-reset
     owned_screens:                      one entry per screen:
       - impl: <path>
         reference: <path or null>
         # when reference is null, also:
         #   reference_search: {at_sha, locations, method, result}
         #   carve_out_approved_by: <a named human>
         #   carve_out_date: <YYYY-MM-DD>  -->

**Size:** <N> files · <FE / BE / full-stack> · security-sensitive: <yes/no>
<security-sensitive: yes adds an independent signature. It reduces nothing.>

## 1. What & why (read this first)
<2–4 plain sentences: what the user gets when this is done, and the approach in
one line. No jargon — write it for the person approving, not for the builder.>

## 2. Build sequence
| # | Step (plain words) | Files touched | Depends on | Par |
|---|---|---|---|---|
| 1 | Add the state/data layer for X | <real path, in THIS repo's layout> | — | A |
| 2 | Add the Y lookup service | <real path> | — | A |
| 3 | Build the X list screen | <real path(s), incl. template/style files> | 1 | B |

## 3. Risks & unknowns
| Risk / unknown | Why it matters | What I'll do |
|---|---|---|
| <spec doesn't say what happens on empty results> | blocks the empty state | ask user / assume Y and flag it |
<or: "None found — checked <what you checked>.">

## 4. How I'll prove it works
- <one bullet per build step: the test or check that shows it's done>
- <security-sensitive: the failing test that comes FIRST>
- <tests assert behavior, not implementation>

## 5. Not in this ticket
- <explicitly out of scope>

## 6. Rejected alternative
<one line: the other approach considered, and why not>

## 7. Cross-model plan critique
**Ran:** <yes — codex <version>, session <threadId>> / <no — unavailable; this
plan carries no cross-model review>

| Finding (severity) | Disposition | Reason / what changed |
|---|---|---|
| <blocker: step 2 imports X, which step 4 creates> | incorporated | resequenced — X now lands in step 1 |
| <minor: extract a shared helper> | rejected | one call site today; YAGNI until there's a second |

## 8. What runs concurrently later
| Stage | Fans out by | Count for this ticket |
|---|---|---|
| parity | **reference-backed** owned screen | <N reference-backed; plus M unreferenced carve-outs, or "n/a — no UI"> |
| attack inventory + design | trust boundary | <N surfaces, or "n/a"> |
| the rule pass | rule family | <the families the diff puts in force> |

Live attacks stay serial regardless — shared port and datastore.
```

## The `Par` column

Steps sharing a letter have no dependency on each other and **touch no file in
common**, so they are built concurrently. Steps with no peer get their own letter.
Two rules keep the column honest: a step may only share a group with steps it does
**not** list in *Depends on*, and **two steps touching the same file are never in
the same group** — that is a write conflict, not parallelism. If everything is
sequential, say so; a column of A B C D is a real answer.

### Full-stack: the frontend does not wait for the backend

What the frontend depends on is the **API contract — the request and response
shape — not the backend's implementation of it.** Pin the contract as its own
first step; frontend and backend then sit in the same group:

| # | Step | Depends on | Par |
|---|---|---|---|
| 1 | Produce the artifact the frontend compiles against | — | A |
| 2 | Build the endpoint: handler, service, data access | 1 | **B** |
| 3 | Build the screen against the agreed shape | 1 | **B** |
| 4 | Wire the screen to the live endpoint and verify end to end | 2, 3 | C |

**Step 1 must name an artifact, not an agreement.** "We agreed the shape" is not
something a compiler accepts:

- the repo **generates its client** from a committed schema (`openapi.json`, a
  `.proto`, a GraphQL SDL) → step 1 is *generate and commit that schema*;
- there is a **shared types package or DTO file** both sides import → that file;
- neither → the shape written into the plan, and the frontend hand-writes a
  temporary interface it deletes at the wiring step.

Check for a generator before assuming the third case: a repo that generates *and*
forbids hand-written shapes — a conformance test, a lint rule — will reject the
temporary interface.

**Even then, usually only part of the frontend waits, and which part is a question
about this repo, not a category.** Blocking the whole frontend on a generated
client blocks more than the generator gates; assuming components and tests are
independent blocks less, because many codebases import the generated DTOs
directly. **Derive the split from the imports**: trace what actually consumes the
generated types and put only those files in the waiting group. Anything provably
clear of them starts immediately. If a file's dependency is unclear, it waits.

What genuinely cannot overlap: verifying against the real endpoint, and attacking
it. And if the shape is *not* settled — the ticket is vague, or it depends on a
decision nobody has made — that is a *Risks* row or a ✋ STOP, not a parallelism
problem. Building both halves against different guesses is worse than serialising.

## Formatting rules that keep it readable

- **Section 1 is the approval surface.** A reader should be able to approve from
  sections 1–3, plus any *rejected blocker* row in section 7, in under a minute.
- **Plain words in the Step column** — "Build the login form", not "Instantiate
  the auth presentational component per NG-ARCH-03". Rule IDs belong in the
  contract, not here.
- **Real paths from this repo**, derived from the detected layout.
- **Tables, not paragraphs**, for sequence and risks — they make an empty risks
  table impossible to fake ("None found" must name what was checked).
- **Short beats complete.** A plan nobody reads gates nothing. A big ticket gets
  more rows, not more prose.

## The Design Contract

The contract governs **which files may be written**, so it must exist before any
code. Branch first, then:

1. **Confirm the routing** still selects the same family member now the plan is
   final.
2. **Invoke that skill by name** — load it, do not recall it.
3. **Run its Design Contract gate**, deriving the file list from the approved
   build sequence.

### When the routed skill has no contract gate of its own

`angular-code-quality` and `backend-code-quality` each define one. **The
`code-quality` hub does not** — so every stack that routes to the hub (React, Vue,
Svelte, Go, Rust, Java, C#) uses the workflow-owned shape below. This is not a
degradation; it is the contract for those stacks.

```
file path | why it exists (the build-sequence step) | its role in this repo's
own architecture | the rules in force for that role
```

Roles come from the repo's actual layout, not from a framework this skill
prefers. The rules in force are every `[NN]` rule, plus the hub's universal core,
plus whatever the repo's own conventions document requires.

### Full-stack: one contract, two specialists

A full-stack ticket invokes two specialists and produces **one** contract and
**one** rule pass — never two uncoordinated halves. Their schemas differ, so
compose rather than concatenate: **one table, one row per file, each row carrying
the role vocabulary of the side that owns it.** A file appears exactly once. Two
tables mean two half-reviews, and a rule that fell between them is invisible.

### The parity metadata

Record `ui_required` and `owned_screens` in the plan's header. `ui_required` is
`contract-owns-a-screen OR diff-touches-the-view-layer`; the first half is known
now, the second is recomputed at the freeze because it cannot be known before
implementation.

**`reference: null` is a human decision made at plan time, never a gate-time
convenience.** It needs the `reference_search` block — where you looked at the
pinned SHA, how, and what you found, so "no reference exists" is reproducible
rather than asserted — and a **named human approver** recorded in the plan the
user approved. CI validates the approver, the date and the search evidence, and
fails closed without them.

**Missing, unparseable or internally inconsistent metadata fails closed** to
`ui_required: true` with no artifact, which is a FAIL.

## The plan constrains the contract

A file the contract needs but the plan lacks means the plan was wrong. That is a
**material divergence**: it goes back through plan mode for re-approval and
updates the artifact. Do not silently build past the plan the user approved.
