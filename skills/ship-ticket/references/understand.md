# UNDERSTAND — the tracker, the triage, the design read, and how recon runs

Loaded when the UNDERSTAND phase starts. The spine carries the four exit
conditions; this carries how to satisfy them.

## Which tracker, and the three operations that differ

| Argument looks like | Tracker | Fetch the spec | Transition to Done | Link the PR |
|---|---|---|---|---|
| `KEY-123`, `…/browse/KEY-123`, an `*.atlassian.net` URL | **Jira** | Atlassian connection (get issue) | the workflow transition to "Done" | PR URL in a ticket comment, or the dev-panel link if that integration exists |
| a bare number `1234`, `#1234`, `AB#1234`, a `dev.azure.com` / `visualstudio.com` work-item URL | **Azure DevOps** | `wit_get_work_item`, expanding relations | `wit_update_work_item` → the type's **completed-category state** | `wit_link_work_item_to_pull_request`, or `AB#<id>` in the PR description on GitHub |

Everything else in this skill is tracker-neutral. Two ADO rules that are not
optional:

- **"Done" is a state category, not a fixed name.** Scrum and Basic use `Done`;
  Agile and CMMI use `Closed`; custom processes use whatever they define. Resolve
  the work item type's actual completed-category state with
  `wit_get_work_item_type` and set that. Never assume the literal string exists.
  **If it cannot be resolved, ✋ STOP** — do not guess a state name and do not
  close the ticket by approximation.
- **The PR host and the tracker are independent.** An ADO work item's code may
  live in Azure Repos (open the PR with the ADO repo tools and link it) or on
  GitHub (open it with `gh` and put `AB#<id>` in the description so the ADO↔GitHub
  integration links it; if that integration is not set up, fall back to
  `wit_add_artifact_link` or a comment carrying the URL). Check `git remote` first.

Ambiguous, or the ID resolves in neither → ✋ STOP and ask. Do not guess.

## Read the spec, in full

Fetch the description, the acceptance-criteria fields, the comments, and the
linked parents and attachments — the spec is routinely split across them. The
availability check needs nothing from the ticket, so it can run alongside this
fetch rather than ahead of it.

Cannot fetch it — auth, IP, wrong instance, missing permission → ✋ STOP.

## Triage — cheap here, expensive later

Run these lookups **concurrently**. Every blocker's state, the assignee, the
ticket state, the branch/PR search and the plan-artifact check are independent;
several blockers means several fetches at once, not a queue. The only thing that
depends on them is your decision after they all return.

1. **Blockers.** Fetch each linked blocker and check its state. Not completed →
   ✋ STOP: name the blocker, its state, and what it was supposed to provide. If
   the user says proceed anyway, record that in the session log.
2. **Acceptance criteria must exist.** With none there is nothing to verify
   against and you would be inventing the definition of done. Ask the user for
   them, or for approval of criteria you propose.
3. **Nobody else is on it.** Check the assignee, the state, and the repo for a
   branch or open PR naming this ticket. Surface it rather than opening a second
   parallel implementation.
4. **Resume, don't restart.** `.specs/plans/<TICKET>.md` present → read
   `approval_status` literally and route through the spine's resume table.
5. **Size it** for the plan's *Size* line — files, subsystems, security-sensitive.
   This shapes how much plan the ticket warrants and how wide the waves fan out.
   **It reduces no check.**
6. **Right-sized?** A spec spanning several independently shippable units — a seam
   plus its consumers, more than one authoritative write path — gets said **now**,
   with a proposed split, and the user decides. Do not silently build a
   three-ticket epic as one PR. If they say build it as one, note it in *Size*.
7. **A STOP here cancels concurrent work.** If triage stops the ticket, stop the
   design read too rather than letting it finish into a run that will not happen.

## The design source of truth

For any ticket that produces or changes UI, read the design system **before
writing a line of frontend code**, and actually open the files. "There is a design
reference" is worthless if nobody reads it; available ≠ consulted.

**It is not one file and not one format.** Depending on how the design was
produced it may be a Claude Design set (`*.dc.html` screen and component files), a
self-contained HTML showcase (one file per surface, pages as `<section>` blocks),
component files (`.jsx`/`.tsx`/`.vue`), or a mix.

**Three things must be opened, and they take two waves:**

1. **The token / theme file** — `tokens.css`, `theme.*`, design-tokens. The single
   source of colour, spacing, type, radius and elevation. Almost always the most
   important and the most often skipped.
2. **The conventions or Master-Orientation doc**, if one exists — brand rules,
   RTL and bilingual rules, numeric isolation, the component inventory.
3. **The referenced screen** — its composition and its imports.

**Wave 1 is those three, concurrently.** Then synthesize a component inventory —
the conventions doc names the required shared components, the screen's imports
name the rest — and **wave 2 opens the union of those components concurrently**:
table, form, drawer, pagination, banner, field renderer. Opening them in wave 1
would mean guessing which matter, and that guess is the dependency this staging
respects.

**Self-locate it.** If the ticket does not point at the design files, or names
them incompletely, search the repo: a token or theme file, a `design/` directory,
a component library, a Master-Orientation doc. The read is mandatory even when the
ticket forgets to reference it. UI in scope and no design system findable → ✋
STOP and ask where it lives. Do not invent a visual language.

### Pinning — this is what makes the parity check real

A parity check against a *moving* reference passes vacuously.

- **The reference must already be committed.** Uncommitted working-tree files, or
  files not in the repo at all → ✋ STOP. There is no SHA to diff against, and a
  screen closed against an uncommitted reference is unverifiable. (This is the
  SCRUM-108 failure: the ticket closed 46 minutes *before* its own reference was
  committed. Nothing could have diffed it.)
- **Record the SHA.** `git rev-parse HEAD` gives the commit; **verify separately
  that the reference path exists at it** — `git cat-file -e HEAD:<path>`. Do not
  write `git rev-parse HEAD -- <path>` expecting a path-specific SHA: it emits the
  OID, `--` and the path on separate lines, and produces a malformed `design_ref`.
- Write it in the plan artifact's header, the parity artifact, and the session
  log. Parity diffs against **this SHA**, never "latest", so the result is
  reproducible and a later reference edit becomes a detectable event rather than a
  silent invalidation.

### Then build by composition

- **Compose the shared components.** "Reimplement in the app framework" means
  reuse the existing table, input, drawer, pager and badge and supply columns,
  rows and field configs. It does not mean hand-rolling equivalents from raw
  markup — that is the main cause of style drift, column collisions and clipped
  controls.
- **Zero hardcoded colour** outside the token file. Colour, spacing, type and
  radius all come from tokens. Prefer to lint-enforce it.
- **Follow the documented conventions**, whatever they actually say. Bilingual or
  RTL projects need mirroring and LTR isolation of numbers, IDs, dates and prices
  inside RTL text. A single-locale LTR project has no such rule — do not invent one.
- **Deficient reference?** If a shared design component is itself defective — a
  paginator rendering every page number with no windowing — fixing it at source
  beats literal fidelity. Fix it, note it, flag it. In the parity artifact it is
  an *accepted deviation* and still needs the human sign-off.

## Detecting the stack

1. **The repo's own instruction file first — check for BOTH `AGENTS.md` and
   `CLAUDE.md`.** Repositories carry one, the other, both, or neither; reading
   only the name you expect silently ignores instructions written for you. If the
   repo documents its stack, conventions or commands there, that is authoritative
   and outranks anything inferred.
2. **Manifests** — `package.json` and which framework is in `dependencies`,
   `composer.json`, `requirements.txt` / `pyproject.toml`, `go.mod`, `Cargo.toml`,
   `*.csproj`, `Gemfile`, `pom.xml`.
3. **The existing code** — how the current routes, components and services are
   actually written. **The repo's established pattern wins** over any convention
   in this file or a quality skill's defaults. A ticket is not a licence to
   introduce a second architecture alongside the one already there.
4. **The commands** — the real lint, build and test commands, from the scripts
   block, Makefile or CI config. Never assume a runner.

Genuinely ambiguous — two frameworks, no manifest, an unfamiliar setup → ask once
rather than guessing. A wrong stack assumption surfaces as a broken build much
later, after a plan was already approved.

### Routing

| The ticket touches | Invoke | Owns |
|---|---|---|
| **Angular** frontend | `angular-code-quality` | `NG-*` |
| **Any other frontend** — React, Vue, Svelte, Next/Nuxt, plain TS | `code-quality` hub | the universal core; its `references/` carry per-stack rule sets |
| **Any backend**, any language | `backend-code-quality` | `BE-*` — it detects the runtime itself |
| **A stack with no reference file** — Go, Rust, Java, C# | `code-quality` hub | the universal principles applied to that language |

**Pass the evidence forward.** The specialist receives the stack profile and the
pinned design evidence you already gathered. It should not reopen the same files
to re-derive the same facts — that is the same agent deriving the same thing twice,
and it costs a wave.

## How recon runs

**If two investigations do not need each other's answer, they run together.**

**Recon runs in waves**, because the questions are not all known up front —
discovering that a component already exists *creates* the next question.

1. Enumerate the questions the plan must answer; dispatch the independent ones
   concurrently as read-only investigations.
2. Synthesize the answers yourself, and let them raise the next wave.
3. Stop when a wave raises no question that would change the plan.

**The stopping rule.** Stated naively — "know every file and every contract" — it
is circular and invites unbounded traversal. So:

- **Closure = the candidate touched-file set, plus each of those files' *direct*
  consumed and exposed interfaces, plus the known callers those affect.** One hop,
  not the transitive graph. A dependency of a dependency is out of scope unless
  the plan actually calls it.
- **Three waves, maximum.** Each must resolve a plan-changing question or end recon.
- **At the cap, an unresolved question becomes output**, not another wave: a row
  in *Risks & unknowns* with what you would do about it, or a ✋ STOP if it
  genuinely blocks the plan.

**Defer the detail of test knowledge, never the paths.** Recon establishes the
repo's real commands and **the exact test and fixture files the plan will create
or touch** — they go in the build sequence, and a test file outside the contract
forces a divergence or quietly pressures you to skip the test. What defers is the
*internal* detail: how an assertion is spelled, how a fixture is built.

**The investigators:**

- **Read-only, and *enforced*, not merely instructed.** Telling a subagent not to
  write is a prompt; plan mode's guarantee is meant to be mechanical. Dispatch
  through a carrier that **restricts their tools** — a read-only sandbox, or a
  subagent type with no edit tools. If your carrier cannot enforce it, run the
  investigations through the plan-mode agent itself. Either way, **snapshot HEAD
  and the worktree around each wave and abort if anything mutated.**
- **They answer questions; they do not make the plan.** Each returns data — paths,
  signatures, quoted lines, a direct answer. Synthesis is yours. A subagent that
  hands back a plan has skipped the step where you reconcile it against every
  other answer.
- **Exploration-tier models.** This is gathering, not architecture.
- **Width equals the number of genuinely independent questions.** Two questions do
  not need six agents.
- **Carrier preference: workflow → fan-out → serial.** A recon wave is exactly the
  deterministic fan-out a workflow runner exists for, and this skill's
  instructions authorize using one. Schema-validating the answers is worth real
  money here: a recon answer that comes back as prose instead of path + signature
  + quoted line has to be re-asked.

Recon investigators return `question` · `answer` · `paths` · `signatures` ·
`quoted lines` · `confidence`. **No manifest ID and no verdict** — recon is
answering questions about code that does not exist yet.

**Good first wave — almost always independent:**

| Investigation | Answers |
|---|---|
| **Does this already exist?** | the component, service or endpoint the ticket is about to duplicate — the most expensive thing to learn late |
| **What contracts does it depend on?** | the API shapes, service methods, types and permissions the plan will call |
| **What precedent does the repo set?** | how this codebase already does this kind of thing |
| **What consumes the surface being changed?** | who breaks, and which tests cover it |
| **What does the design say?** | the token file, conventions doc, screen and shared components |
