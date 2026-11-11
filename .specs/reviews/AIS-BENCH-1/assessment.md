# AIS-BENCH-1 — Comparative assessment: AI-Skills and `msitarzewski/agency-agents`

Date: 2026-11-10. Status on that date: assessment only. Nothing under `skills/`, `scripts/` or `AGENTS.md` was
changed and nothing was committed. `AIS-BENCH-1` is a placeholder key; rename it freely. The
implementation plan is `.specs/plans/AIS-BENCH-1.md` (approval pending).

**Update 2026-11-11.** The text below is the assessment as written on 2026-11-10, except that
three sentences were reworded for publication (the evidence line of M1, row R2 and the adaptive
model routing row); no finding or decision changed. Since then the
owner approved Waves 0, 1 and 2 (decision D1), chose the split fix for the five rule IDs (D4),
ruled that the brief builder is not a harness feature under the freeze (D6), kept the key and
had this file and the plan committed with the Wave 0 pull request (D7). Check E10 was completed
against the primary page: Antigravity's documentation names `~/.gemini/config/skills` and lists
`~/.gemini/antigravity/skills` as legacy, so the install target moves in Wave 0. Decisions are
tracked in GitHub issue #51. Wave 0 fixes gaps G6, G7, G8 and G13 of section 6; the rows below
still describe them as open because they record the state on 2026-11-10.

## 0. Pins, method, limits

| | Repository | Commit |
|---|---|---|
| Ours | AI-Skills `main` | `65b84cd7147afc351a41b2e5ea9465e7e98a6cd3` |
| Reference | `https://github.com/msitarzewski/agency-agents` | `8ae6164602c95ca78828b148b9052460ee426885` (2026-11-08) |

Reference licence: MIT, "Copyright (c) 2025 AgentLand Contributors" (`ext:LICENSE:1-3`).
Citations are `path:line`; reference-repo paths carry the prefix `ext:`.

**Evidence tiers** used for both sides:

| Tier | Meaning |
|---|---|
| INTENT | states a goal or claims a capability |
| INSTRUCTION | tells an agent what to do; nothing enforces it |
| EXECUTABLE | code performs or enforces it |
| TESTED | executable, with an automated test asserting it |
| MEASURED | a result from a real run is recorded |

**What was read, and by whom.**
- Read in full by the author: ours — `ship-ticket/SKILL.md`, `references/execution-harness.md`,
  `references/plan.md`, and the routing, recon, review-contract and proof sections of
  `understand.md`, `review.md`, `prove.md`; the AIS-HARNESS-4 closing record and the SCRUM-307
  baseline record. Reference — six scripts in full (`lint-agents.sh`,
  `check-agent-originality.sh`, `check-runbooks.sh`, `check-tools.sh`,
  `test-agent-selection.sh`, `integrations/mcp-memory/setup.sh`), `tools.json`, the workflow
  steps, and six agent or strategy files in full (`agents-orchestrator`, `minimal-change-engineer`,
  `code-reviewer`, `handoff-templates`, `ai-generated-code-auditor`, `ui-finish-gate-reviewer`).
  Read in part: `nexus-strategy.md` (outline and rule lines), `reality-checker`,
  `evidence-collector`, and the two cited passages of `multi-agent-systems-architect`.
- Not read in full by anyone: `convert.sh`, `install.sh`, `lib.sh`, `check-divisions.sh`, the
  Hermes scripts and the 22 test scripts. The finding that all reference code is packaging rests
  on their headers, the CI steps that call them, and a term search over every non-markdown file.
- Read by three extraction agents (Sonnet, fixed schema, no hypothesis given): the 24 non-test
  harness scripts plus test names; 16 of our other skills (about 66 files); 44 reference-repo
  files. Their full output is kept in `evidence/` beside this file. It is agent output and was
  spot-verified only. That folder is local and is not committed (decision D7), so the
  `evidence/…` citations below point at files this repository does not contain.
- Every line cited behind a non-KEEP decision was re-read by the author. Citations in KEEP rows
  that come from the agents and were not re-read: `gate.mjs:378-392`, `harness.mjs:107-119` and
  `:127-137`, `carrier.mjs:227-228`, `gate.mjs:537-587`, `scripts/cli.mjs:1117-1288`, the
  `generate-ticket` line ranges, and the `ux-audit` rule counts.

**Limits.**
- The reference repo has 283 agent files in 18 divisions. About 40 were read in full. The other
  240 or so (marketing, sales, finance, game development, GIS, healthcare, academic and similar)
  were classified from name, description and size only.
- Test bodies of our harness were sampled, not read in full. No test suite was run for this
  assessment (issue #49: parallel copies of the engine suite give false failures).
- No model run was made. Every impact statement in this document and in the plan is
  **expected, not verified**, unless it is a deterministic count taken from the files.

## 1. Headline findings

1. **The reference repository is a prompt library with distribution tooling. It has no runtime.**
   All 36 script files serve the packaging: conversion, installation, lint, localization and
   tests of those (one only prints setup instructions). Orchestration, retries,
   handoffs, quality gates and memory exist only as markdown instructions.
2. **Where both sides have a capability, ours sits at a higher evidence tier in every row except
   one:** the reference repo tests its installer; our library CLI has no automated test.
3. **Decisions: 0 REPLACE, 3 ADOPT, 3 MERGE, 11 REJECT, 1 VERIFY; the rest KEEP.** Nothing in the
   reference repo is demonstrably better than an implementation we already have.
4. **The audit of our own code found more than the comparison did** (section 6): workers receive
   nothing but a hand-written prompt file; a worker's structured report is ignored by the engine;
   there is no way to accept a small extra file mid-run; any durable stop halts unrelated work;
   no code selects which checks to run; five rule IDs cited by `nn-guard` are not defined by the
   skill that owns them; the `session-restore` extraction command prints an empty line.
5. **The largest cost lever is orchestrator overhead, which the reference repo does not address.**
   The one recorded baseline (SCRUM-307, n=1, not a clean engine-gated run) shows about 183M
   tokens, 93.4M of them in the orchestrator
   (`.specs/reviews/AIS-HARNESS-3/wave4-baseline-scrum307.md`).

## 2. What the reference repository is

| Fact | Evidence |
|---|---|
| 384 tracked files: 330 `.md`, 31 `.sh`, 4 `.py`, 1 `.ps1`, 9 `.yml`, 4 `.json` | `git ls-files` at the pin |
| 283 agent files (frontmatter) in 18 divisions | `ext:divisions.json`; count by first-line `---` |
| Executable code is packaging only: `convert.sh` (954 lines, 15 output formats), `install.sh` (1801), `lib.sh`, `lint-agents.sh`, three consistency checks, a Hermes plugin builder, 22 test scripts, 6 CI workflows | `ext:scripts/`, `ext:.github/workflows/` |
| No runtime terms in any executable file: `checkpoint`, `resume`, `worktree`, and any model name give 0 files; `retry` appears in `install.sh` only | grep over all non-markdown files |
| Orchestration is a prompt: "Maximum 3 attempts per task before escalation"; "After 3 failures: Mark task as blocked, continue pipeline"; "Final integration will catch remaining issues" | `ext:specialized/agents-orchestrator.md:44`, `:161`, `:162` |
| No human approval boundary: the pipeline runs "with single initial command" and gates are judged by other agents | `ext:specialized/agents-orchestrator.md:33-37`; `ext:strategy/playbooks/phase-4-hardening.md:19` |
| No model-selection rule anywhere in the files read | `evidence/external-breadth.md`, repo-wide question (a); author grep of executables |
| Success metrics are targets with no data: "Task first-pass QA rate 70%+", "Phase completion rate 95% on first attempt" | `ext:strategy/nexus-strategy.md:763-767`; `evidence/external-breadth.md` found no dataset, log or test behind any numeric claim in the 44 files it read |
| "Memory" ships no server and no code: the setup script prints instructions; "The memory instructions are prompts, not code" | `ext:integrations/mcp-memory/setup.sh:14-22`; `ext:examples/workflow-with-memory.md:237` |
| Two agents call a script the repo does not ship (`./qa-playwright-capture.sh`); one cites a standard that does not exist (`security/17-security-pattern.md`) | `ext:testing/testing-reality-checker.md:63`; `ext:testing/testing-evidence-collector.md:44`; `ext:security/security-senior-secops.md:15`; 0 matches in `git ls-files` for both |
| What is well engineered: one JSON source of truth per catalogue, each with a CI check that every consumer agrees; installer tests on two operating systems | `ext:scripts/check-tools.sh:5-11`; `ext:scripts/check-runbooks.sh:8-14`; `ext:.github/workflows/test-install.yml:19` |

The last two rows matter for the comparison. A mandatory step that calls a missing script is the
failure our validator's invariant 3 exists to catch. The single-source consistency checks are the
part of the reference repo worth learning from.

## 3. Capability matrix

`T:` is the evidence tier. "Ours" cites the strongest implementation found.

| # | Capability | Ours | Reference | Decision |
|---|---|---|---|---|
| C1 | Ticket generation and planning | `generate-ticket` (11-section template, split rules, CSV; `skills/generate-ticket/SKILL.md:191-235`); plan template (`ship-ticket/references/plan.md:95-228`). T: INSTRUCTION | task lists from a spec (`ext:project-management/project-manager-senior.md`), phase playbooks. T: INSTRUCTION | KEEP |
| C2 | Human plan approval | one approval, consumed once (`SKILL.md:389-393`); `init` recomputes the plan digest against the `START` event (`execution-harness.md:355-365`). T: TESTED | the pipeline itself has none: agents gate each other. One prompt lists criteria for placing a human gate (`ext:engineering/engineering-multi-agent-systems-architect.md:331-339`). T: INSTRUCTION, criteria only | KEEP (the criteria feed M2) |
| C3 | Plan-bound execution | every mutating command re-verifies run, plan digest and DAG digest (`approval_mismatch`, `dag_mismatch`). T: TESTED | ticket ID required in branch and commit names (`ext:project-management/project-management-jira-workflow-steward.md:42`, `:96-97`). T: INSTRUCTION | KEEP |
| C4 | Parallel worker DAG | ready-set scheduling, overlap and lock serialization, memory admission (`harness.mjs`, `run-engine.mjs`). T: TESTED | "Parallel tracks" in prose; the build loop is one task at a time (`ext:specialized/agents-orchestrator.md:79-96`). T: INSTRUCTION | KEEP |
| C5 | Worker ownership and isolation | declared `writes`; after-the-fact snapshot check fails the node (`engine-attempts.mjs:154-158`). No worktrees; concurrent siblings' paths are exempt; ignored paths invisible (`execution-harness.md:197-206`, `:881-882`). T: TESTED (detection) | a `git worktree` example (`ext:engineering/engineering-git-workflow-master.md:69`). T: INSTRUCTION | KEEP; limits already documented |
| C6 | Worker contract and handoff | typed dispatch JSON; a `ship-ticket-report` block validated on the manual carrier path only (`carrier.mjs:446`); the engine passes only the node's `promptFile` and adds nothing (`engine-attempts.mjs:300-303`; `launcher.mjs:111`). T: TESTED (dispatch), report unused by the engine | handoff template with current state, relevant files, acceptance criteria, evidence required (`ext:strategy/coordination/handoff-templates.md:24-44`). T: INSTRUCTION | **MERGE (M1)** |
| C7 | Context and codebase discovery | recon in at most three waves, one-hop closure, answers as path + signature + quoted line (`understand.md:190-243`). Nothing carries those answers into a worker's prompt. T: INSTRUCTION | orientation map and discovery commands (`ext:engineering/engineering-codebase-onboarding-engineer.md`, `ext:specialized/specialized-codebase-archaeologist.md`). T: INSTRUCTION | KEEP the method; the missing carry-over is part of M1 |
| C8 | Model and agent selection | four tiers; eight closed risk labels and `complexity: high` force `strong`; `strong` refused without a mapped model (`harness.mjs:107-119`; `carrier.mjs:227-228`). T: TESTED | none for models; agents picked from a prose roster (`ext:specialized/agents-orchestrator.md:117-122`) | KEEP |
| C9 | Risk-based validation | risk label → required evidence kinds (`harness.mjs:127-137`); security controls selected from cited facts. Selection of which checks to run: none in code; ship-ready runs every `testCommands` entry (`engine-gates.mjs:235`). T: TESTED (evidence kinds), MEASURED (control selection: "On this corpus the catalog did not show useful selection") | none | KEEP; gap G5 has no external answer |
| C10 | Security | four skills, 25-control catalogue, catalog-bound gate, committed abuse tests. T: TESTED and MEASURED | 12 security prompts; one has concrete checks absent from ours (`ext:security/security-ai-generated-code-auditor.md`). T: INSTRUCTION | KEEP mechanics; **ADOPT (A3)** content, gated on a scope decision |
| C11 | Code quality and independent review | rule IDs, one bounded review, mandatory second opinion, reviewer ≠ builder enforced (`gate.mjs:378-392`). T: TESTED | a 76-line generic checklist (`ext:engineering/engineering-code-reviewer.md`). T: INSTRUCTION | KEEP |
| C12 | Minimal change and scope governance | the Design Contract names every file; another path is a human stop (`SKILL.md:201-202`, `:300-301`); an out-of-ownership write fails the node. No path for a small approved extra. T: TESTED (detection) | line-level restraint and "surface, don't silently expand" (`ext:engineering/engineering-minimal-change-engineer.md:36-49`); gate-placement criteria (`ext:engineering/engineering-multi-agent-systems-architect.md:331-339`). T: INSTRUCTION | **MERGE (M2)** |
| C13 | Failure recovery | atomic state, launch handshake, crash reconciliation, one retry per node, `resume`, `archive`. T: TESTED | "retry up to 3" and an escalation template. T: INSTRUCTION; memory: INTENT | KEEP; gap G4 |
| C14 | Cost, tokens, latency | per-attempt usage, budgets at 80% and 100%, `eval.mjs` report; one recorded baseline. T: TESTED, one MEASURED run | none for agent runs | KEEP; gap G1 |
| C15 | CI/CD, release, completion evidence | ship-ready conjunction (`gate.mjs:537-587`). PR, CI result and tracker close are instructions in `ship.md`; no script records them. T: TESTED (ship-ready), INSTRUCTION (after it) | pipeline YAML samples. T: INSTRUCTION | KEEP; gap G9 |
| C16 | UI/UX and accessibility | parity against a pinned reference; `ux-audit` has an automated accessibility lane (45 of 217 rules automated). `ship-ticket` runs no accessibility check; none exists outside `ux-audit`. T: TESTED (`ux-audit`), INSTRUCTION (parity) | audit prompt with an axe command (`ext:testing/testing-accessibility-auditor.md:228`); finish-gate prompt. T: INSTRUCTION | KEEP; gap G10 is closed by reusing our own lane |
| C17 | Evaluation and improvement | `eval.mjs`, `engine-bench.mjs`, mutation and crash suites, the catalogue effectiveness report. No stored engine benchmark results. T: TESTED, MEASURED (catalogue) | "Never deploy … without an eval suite with ≥20 representative test cases" (`ext:engineering/engineering-multi-agent-systems-architect.md:514-519`). T: INSTRUCTION | **MERGE (M3)** |
| C18 | Library validation and distribution | validator with 11 checks (`scripts/cli.mjs:1117-1288`); install, update, autoupdate. No automated test of `cli.mjs` (1516 lines) or `autoupdate.mjs` (387). T: EXECUTABLE | 1,784 lines of installer and converter tests on two operating systems; catalogue consistency checks. T: TESTED | **ADOPT (A1, A2)** |

## 4. Checks run for this assessment

All read-only, on our tree at the pin unless stated. Scripts are in the session scratch
directory, not in the repo.

| ID | Check | Result |
|---|---|---|
| E1 | Size of the `ship-ticket` spine plus references | 266,053 bytes in 12 files; `execution-harness.md` is 67,942 bytes (26,436 tokens as counted by the reading tool, which includes its line-number prefixes, so about 2.6 bytes per token is a low estimate of bytes per token). Opt-in unit text: 14,986 bytes in `execution-harness.md` and 10,373 bytes in `review.md` |
| E2 | Do rule IDs cited across skills exist in the owning skill? | Five IDs do not: `BE-SEC-10`, `BE-AUTH-08`, `BE-AUTH-09`, `BE-VAL-05`, `BE-HDR-06`. `nn-guard` cites `BE-SEC-10` and the ranges `BE-AUTH-01…09`, `BE-VAL-01…05`, `BE-HDR-01…06` (`skills/nn-guard/SKILL.md:40`, `:101`; `references/enforcement-map.md:10`, `:29-30`); `backend-code-quality` defines `BE-SEC-01..09`, `BE-AUTH-01..07`, `BE-VAL-01..04`, `BE-HDR-01..05`. Every other explicit ID and every other range on those lines (`BE-WHK`, `BE-TEN`, `BE-AUD`, `BE-RT`, `NG-SEC`, `NG-CORE`) resolves |
| E3 | Unclosed code fences in our markdown (the reference linter's check) | 0 files |
| E4 | Duplicated text between our skills (8-word shingles, the reference originality method) | 87 documents; 2 cross-skill pairs share 25 or more shingles, both between the two code-quality specialists, which are parallel on purpose (13 of 37 long paragraphs identical or near-identical) |
| E5 | Does a worker brief have to list existing helpers to reuse? | No such requirement in `ship-ticket`. Reuse is asked of recon (`understand.md:249`) and of UI composition (`understand.md:140-144`) |
| E6 | Does the reference repo ship the script its QA agents call? | No (0 matches) |
| E7 | Our skills on LLM-application risks | 0 mentions of prompt injection outside the vendored `security-audit` skill |
| E8 | Do the reference security prompts cover the classes our catalogue measured as uncovered (regular-expression and parser denial of service, symlink escape, personal data in logs, output encoding)? | One table row on regular-expression denial of service (`ext:security/security-appsec-engineer.md:434`); 0 files on symlinks, recursion depth or decompression; passing mentions elsewhere. Not a source for those gaps |
| E9 | `session-restore`'s extraction command on a two-entry log | prints one newline and nothing else (`skills/session-restore/SKILL.md:37`): the first rule ends in `next`, so the rule that saves the last block never runs |
| E10 | Antigravity install path | ours `~/.gemini/antigravity/skills` (`scripts/cli.mjs:48`); reference `~/.gemini/config/skills` (`ext:tools.json:13`). A web search says the current docs name the second and still support the first. Not checked against the primary page |

## 5. Decisions

Rule applied: a decision other than KEEP needs a named gap or recorded failure on our side, a
side-by-side with our closest text, and a cheap check.

### 5.1 KEEP

| Capability | Why ours stands |
|---|---|
| Human approval and plan binding (C2, C3) | Enforced and tested; the reference has neither |
| Dependency scheduling (C4) | Tested scheduler against a serial prose loop |
| Model tiers (C8) | Tested routing with a closed risk vocabulary; the reference has no model rule |
| Bounded review (C11) | One repair and one confirmation, reviewer ≠ builder enforced. The reference loops up to three times per task with an agent as judge |
| Recovery (C13) | Crash-tested state machine against an instruction to retry |
| Usage accounting (C14) | Tested; the reference has none |
| Security mechanics (C10) | Catalog-bound gate with committed tests; the reference is prompts |
| Ticket generation (C1) | Equivalent tier, ours is tracker-shaped and feeds `ship-ticket` |
| Ship-ready conjunction (C15) | Tested; the reference has no completion gate |

### 5.2 ADOPT

**A1 — Automated tests for the library CLI.**
1. Ours: `scripts/cli.mjs` and `scripts/autoupdate.mjs` implement install, update with three
   outcomes, manifests, build-then-swap and hook wiring. CI runs `validate` and the skill test
   suites; nothing tests the CLI (`.github/workflows/validate.yml:21-35`).
2. Reference: `ext:scripts/test-install.sh` and eight further installer tests, run on ubuntu and
   macOS (`ext:.github/workflows/test-install.yml:19`).
3. Difference: theirs is TESTED, ours EXECUTABLE.
4. Evidence: AGENTS.md records several CLI defects found after the fact (manifest trust,
   destroy-then-write, hook quoting). No test pins any of the fixes.
5. Impact (expected): regressions in install and update are caught in CI. No token or time effect.
6. Risk: low; tests run in a temporary home directory.
7. Approach: adopt the pattern, not the code. `node:test`, temporary `HOME`, one test per
   documented behaviour, on the existing three-system matrix.

**A2 — Cited identifiers must resolve.**
1. Ours: the validator checks links, scripts, orphans and retired vocabulary. It does not check
   that a rule ID cited in one skill exists in the skill that owns it.
2. Reference: every roster slug must match a real agent file, or the build fails
   (`ext:scripts/check-runbooks.sh:8-14`); the same pattern for tools and divisions.
3. Difference: one catalogue, checked consumers.
4. Evidence: E2. `nn-guard` enforces `BE-SEC-10` in its hook; no skill defines it.
5. Impact (expected): a renamed or removed rule can no longer leave a live citation.
6. Risk: low. Which side is right for the five IDs is an owner decision.
7. Approach: a twelfth validator check with the owner table of ID prefixes, expanding ranges
   such as `01…09`; repair the five IDs first so the check lands green.

**A3 — LLM-application controls (only if you widen the catalogue's scope).**
1. Ours: `VAPT-WEB-03` covers a key in the client bundle; `VAPT-ABUSE-01` and `-07` cover
   unproven identity and server-owned fields. Nothing covers untrusted input reaching a model's
   instructions or a tool-enabled call (E7).
2. Reference: input in a system prompt, or in a call that also grants tools; client-exposed
   environment prefixes; a client-editable field used for authorization
   (`ext:security/security-ai-generated-code-auditor.md:23-36`, `:107-123`).
3. Difference: theirs names the sink and the safe pattern that must stay silent.
4. Evidence: a coverage gap by inspection only. No finding of ours shows it was missed.
5. Impact: unknown. The closing record says the catalogue "did not show useful selection"; adding
   controls does not change that, and no security claim follows.
6. Risk: a change to `skills/vapt/controls.json` makes `effectiveness.test.mjs` fail by design
   and needs a new pre-registered run.
7. Approach: owner scope decision first. If yes, write the controls in our catalogue format with
   attribution, then re-measure.

### 5.3 MERGE

**M1 — A generated worker brief.**
1. Ours: the spine lists what an ownership packet holds (`SKILL.md:149-155`), but the engine sends
   only the hand-written `promptFile`. The structured report is parsed on the manual path only.
   Recon answers are not carried to workers.
2. Reference: handoff fields (`ext:strategy/coordination/handoff-templates.md:24-44`) and a
   handoff contract with payload, success, failure and timeout
   (`ext:specialized/specialized-workflow-architect.md:164`).
3. Difference: they define what a brief contains and enforce nothing; we enforce the dispatch and
   leave the content to the orchestrator's memory.
4. Evidence: E5; `eval.mjs` already names the failure ("more than one REVIEW repair → the brief
   was too weak", `execution-harness.md:837`).
5. Impact (expected): fewer review repairs caused by missing context; less repeated exploration by
   workers. Measured by `review_repairs` and the `brief_too_weak` suggestion in `eval`.
6. Risk: low. The engine still takes a `promptFile`; nothing in the engine changes.
7. Approach: a deterministic builder that composes the brief from the DAG node, the approved plan
   and recon answers (ownership, forbidden paths, required tests, a reuse inventory of
   path + signature, the report block), plus a lint that refuses a brief missing a section.

**M2 — Scope governance with an approved expansion envelope.**
1. Ours: every path outside the Design Contract is a human stop; in the engine it fails the node
   and raises a durable judgment (`engine-attempts.mjs:154-158`). `needs_outside_ownership` has
   no consumer. This is stricter than the mission's rule that necessary, low-risk complementary
   changes may proceed.
2. Reference: "note it as a separate follow-up, not a sneak edit"
   (`ext:engineering/engineering-minimal-change-engineer.md:37`); criteria for when a human gate
   is warranted: irreversibility, blast radius, low confidence, novelty, regulation, policy
   (`ext:engineering/engineering-multi-agent-systems-architect.md:331-339`), with the warning that
   constant interruption turns approval into rubber-stamping (`:325`).
3. Difference: theirs leaves the call to the worker; ours leaves no call at all.
4. Evidence: `evidence/ours-harness-scripts.md`, topic T11 (no mid-run expansion mechanism),
   verified at the lines above. The SCRUM-307 baseline had two engine stops that needed hand work.
5. Impact (expected): fewer overnight stops for trivial additions, with the approved plan still
   the boundary. Measured by judgments and owner stops per run.
6. Risk: medium. It is an engine change (feature freeze) and it touches the authorization
   boundary; it must fail closed.
7. Approach: the plan may approve an envelope (path patterns, a file cap, kinds allowed). The
   envelope can never cover a risk-labelled node's paths, contracts, migrations, auth or plan
   roots. Inside it, a write is recorded as a scope event and reviewed like any candidate path.
   Outside it, today's behaviour. No envelope in the plan means byte-identical behaviour.

**M3 — Evaluation before a harness change.**
1. Ours: `eval.mjs` and `engine-bench.mjs` exist; no results are stored; the unit-arm run is owed.
2. Reference: baseline, new score, regression check before any agent change
   (`ext:engineering/engineering-multi-agent-systems-architect.md:514-519`). The threshold of 20
   cases has no data behind it and is not adopted.
3. Difference: a rule with no suite against a suite with no rule.
4. Evidence: `execution-harness.md:888-890` ("Real-ticket savings are not measured").
5. Impact: makes every later claim checkable. No direct saving.
6. Risk: low.
7. Approach: a fixed scenario set (plan, section 9), run before and after each wave, results
   checked in.

### 5.4 REPLACE

None. In every row where both sides have an implementation, ours is enforced or tested and theirs
is an instruction. The one area where their engineering is stronger is adopted as A1 and A2.

### 5.5 REJECT

| # | Reference idea | Why not |
|---|---|---|
| R1 | A roster of 283 persona agents chosen by name | Agent proliferation. Our skills are capabilities routed by detected stack; a persona adds prompt text, not a check |
| R2 | Seven-phase pipeline with a build↔QA loop per task, three retries, then "mark blocked, continue" | Each loop is a builder plus a judge; our review is bounded lower on purpose (one repair batch and one confirmation). "Final integration will catch remaining issues" contradicts evidence-based completion |
| R3 | Reality-checker and evidence-collector procedures | Hard-coded stack paths and a script that is not shipped (E6). Their principle (default to not ready; a screenshot does not prove behaviour) is already enforced by our gates |
| R4 | MCP memory integration | A placeholder. Our run state, `resume` and session log are real |
| R5 | Conversion to 15 tool formats | `SKILL.md` is already the portable form; skills with scripts and references do not flatten into one rule file |
| R6 | Originality check and fence lint | E3 and E4 found nothing to fix |
| R7 | Their success-metric targets | Targets with no data |
| R8 | A "follow-ups noted but not done" list in every PR | Conflicts with our rule that nothing is filed as a follow-up silently and that the completion report carries no follow-up list (`SKILL.md:726-731`) |
| R9 | UI finish gate against generic UI | No recorded failure of ours that it would have caught; parity, the plan sketch for screens with no reference, and `ux-audit` cover the ground |
| R10 | Branch and commit regex with emoji prefixes | Repository conventions win in our workflow |
| R11 | Circuit-breaker and shared-state JSON samples | Illustrations; our state machine is tested |

### 5.6 VERIFY

V1 — Antigravity install path (E10). Check the primary documentation page, then keep the current
path, switch, or install to both.

### 5.7 Disposition per skill

Tier and facts for skills other than `ship-ticket` come from `evidence/ours-other-skills.md`.

| Skill | Tier | Disposition |
|---|---|---|
| `ship-ticket` | TESTED harness, INSTRUCTION spine | M1, M2, G1 to G5, G9, G11, G12 |
| `generate-ticket` | INSTRUCTION; its consistency pass is a self-check | KEEP. Fix the stale template line (G13). No recorded failure asks for a checker |
| `project-audit` | TESTED continuity checker, otherwise INSTRUCTION | KEEP, no change. The reference has no coverage matrix or pinned-state audit |
| `code-quality` (hub) | INSTRUCTION | KEEP. No reference files for Go, Rust, Java, C#, Ruby or Kotlin; the hub's universal core covers them. The reference's language prompts were not read; add a reference when a project needs one |
| `angular-code-quality` | INSTRUCTION, five smoke greps | KEEP |
| `backend-code-quality` | INSTRUCTION, five smoke greps | Define or correct the five IDs (A2, D4). A reuse rule ID is optional (G14) |
| `test-quality` | INSTRUCTION | KEEP. Go is named as a trigger with no reference file |
| `docs-accuracy` | INSTRUCTION | KEEP |
| `pr-review` | INSTRUCTION | KEEP |
| `session-logger`, `session-restore` | INSTRUCTION with inline shell | Fix the extraction command (G7) |
| `self-healing` | INSTRUCTION | KEEP. A lesson is written to `CLAUDE.md` or a `SKILL.md`; nothing checks later that it prevented a repeat. The reference's "Learning & Memory" sections are prose and offer no mechanism. Fix the skill count (G13) |
| `cost-reducer` | INSTRUCTION | KEEP. It has one line on model choice and nothing on multi-agent orchestration; the measured rules live in `ship-ticket/SKILL.md:534-585`. Not planned: a pointer from one to the other |
| `nn-guard` | EXECUTABLE, self-test at install, no repo test | Correct the ID map (A2). A repo test of the embedded script is optional in Wave 0 |
| `security` | INSTRUCTION | KEEP |
| `security-audit` | vendored | untouched |
| `vapt` | TESTED and MEASURED | KEEP. A3 only on your scope decision |
| `ux-audit` | TESTED for the automated lane | KEEP. Its lane is the reuse candidate for G10 |
| `researcher`, `linkedin-content-coach`, `marketing-video`, `design-prompts` | not assessed | outside the engineering lifecycle; two have work in progress |

### 5.8 Disposition of the candidate architecture features

| Candidate | State today | Disposition |
|---|---|---|
| Capability-based agent selection | stack routing table and companion detection (`understand.md:176-183`) | KEEP. No registry: the only cross-skill drift found is the rule-ID citation, which A2 covers |
| Shared domain expertise | hub, specialists, cross-skill references with fallback summaries | KEEP. Missing language references are added on need |
| Typed worker contracts | dispatch typed and tested; report typed but unused | M1, then W3-evidence |
| Context-efficient handoffs | recon answers are not carried to workers; references are large | M1 and G1 (Wave 2) |
| Dependency-aware parallel execution | TESTED | KEEP |
| Risk-aware review and testing | review: profiles, risk → evidence kinds, second-opinion rules, TESTED. Check selection: none in code | KEEP review. G5: measure first |
| Adaptive model routing | static tiers. Neither side routes on demonstrated performance | Not planned. One baseline run is too little data; the engine already records builder identity and review outcome per run, so this can be revisited after more runs |
| Failure recovery | TESTED | KEEP. Isolation is limited by the shared work tree (G4) |
| Scope governance | hard stop on any extra path | M2 |
| Execution observability | run log, engine events, `status`, `eval` | KEEP. G9 and G12 in Wave 3 |
| Evaluation-driven optimization | tools exist, no stored results | M3 (Wave 1) |

## 6. Gaps in our own system found by the audit

These do not come from the reference repo. Tier and location as verified.

| # | Gap | Evidence | Priority |
|---|---|---|---|
| G1 | Fixed orchestrator context is large: 266 KB of spine and references; about 25 KB of opt-in unit text sits in files a run without units also loads | E1; baseline orchestrator share about 51% | P1 |
| G2 | The engine sends only the prompt file and ignores the worker's structured report | `engine-attempts.mjs:300-303`; `launcher.mjs:111`; `carrier.mjs:446` is the only parser call | P1 (with M1) |
| G3 | No mid-run scope expansion path | `engine-attempts.mjs:154-158`; no consumer of `needs_outside_ownership` | P2 (M2) |
| G4 | Any durable judgment stops all dispatch, including nodes that do not depend on the failed one. For most codes this is correct today: workers share one work tree and an offending write is not reverted, so `ownership_violation`, `ownership_unavailable`, `crash_with_writes`, `quiescence_unknown` and `post_freeze_drift` concern the whole tree. Only codes that concern one node's inputs (for example `red_required`, `red_invalidated`) could be scoped without worker isolation | `engine-attempts.mjs:394`; code list at `execution-harness.md:685-699` | P2, analysis first |
| G5 | No code selects which checks to run; reruns after a repair run every command; lint and typecheck run only if the plan lists them | `engine-gates.mjs:235`; the selection rule in `SKILL.md:310` is an instruction | P2 |
| G6 | Five rule IDs cited by `nn-guard` are not defined by `backend-code-quality` | E2 | P1 (A2) |
| G7 | `session-restore`'s extraction command returns nothing | E9 | P1 |
| G8 | No tests for the library CLI | A1 | P1 |
| G9 | PR, CI result and tracker close are not recorded by any script; "complete" after ship-ready rests on instructions | `evidence/ours-harness-scripts.md`, topic T15 (not re-read by the author) | P3 |
| G10 | No accessibility check in `ship-ticket`'s UI proof; `ux-audit`'s automated lane is not reused | no accessibility term in `design-parity.md`; none outside `ux-audit` | P3 |
| G11 | The PROVE repair counter has a consumer and no producer in the scripts | `engine-attempts.mjs:432-435`; no code creates a `prove` repair | P3, decide: wire or delete |
| G12 | Orchestrator and reviewer usage is imported by hand, so the orchestrator share is often unknown | `usage.mjs import-session`; baseline caveat | P3 |
| G13 | Small drift: `generate-ticket/references/ticket-template.md:111` says a security-sensitive ticket "routes to its strong model" against `SKILL.md:218-220`; `self-healing/references/skill-creation-guide.md:5` says 17 skills (22 exist) | `evidence/ours-other-skills.md`, "Items worth a second look"; not re-read by the author | P1, trivial |
| G14 | `backend-code-quality` has no "reuse before create" rule ID; Angular has `NG-ARCH-07` | `evidence/ours-other-skills.md`, cross-skill answer (a); not re-read by the author | P3 |

Already known and documented, not re-opened here: no worktree isolation, sibling write exemption,
ignored paths invisible to the ownership check, Windows quiescence, the backdated-`START` limit,
issue #49, and the unit-arm run still owed under the feature freeze.

## 7. Architecture decision records (proposed)

| ADR | Decision | Alternatives rejected | Consequence |
|---|---|---|---|
| ADR-1 | Capabilities stay skills routed by detected stack. No persona roster | the reference roster (R1) | New expertise is added as rules or references inside an owning skill |
| ADR-2 | Review stays one repair and one confirmation | three-retry build↔QA loop (R2) | A failed confirmation remains a terminal result |
| ADR-3 | The approved plan may carry an expansion envelope; outside it, today's stop | every extra path is a stop (today); worker discretion (reference) | The plan stays the authorization boundary; small approved extras no longer end an overnight run |
| ADR-4 | Worker briefs are generated and linted, not hand-written | free-form prompt files (today); prose templates (reference) | Reuse inventory and report block cannot be forgotten; the engine is unchanged |
| ADR-5 | Orchestrator context size is a tracked number; opt-in feature text lives in opt-in files | leave references as they are | A byte budget per phase is checked when a reference changes |
| ADR-6 | Cross-skill identifiers must resolve; the library CLI is tested | rely on review | Two new CI checks |
| ADR-7 | No catalogue change without a new pre-registered measurement; LLM-application controls are an owner scope decision | add controls now | No security claim is made from this assessment |

## 8. Work in progress observed

Based on `git diff --stat origin/main...<branch>` and `git status`, 2026-11-10.

- `main` is clean apart from the untracked `.claude/` directory. No open pull request. One open
  issue (#49).
- Two local branches are not merged: `fix/ship-ticket-wave-session-rule` (one file, 14 lines in
  `plan.md`; the same wording is on `main` at `plan.md:51-63`, so it looks superseded, not checked
  line by line) and `feat/ship-ticket-concurrent-review-wave` (2026-09-08, `SKILL.md` only,
  predates the current spine).
- The two agent worktrees under `.claude/worktrees/` point at commits already in `main`.
- The engine feature freeze is in force (`.specs/plans/AIS-HARNESS-3.md:102`). The plan treats
  every engine change as an owner decision.

## 9. What is not established

- No benchmark was run. The baseline is one ticket, one arm, and not a clean engine-gated run.
- How much of the orchestrator's token use is fixed reference text is unknown; E1 gives bytes,
  not the number of turns they were re-read on.
- Whether a generated brief reduces review repairs is a hypothesis.
- About 240 reference-repo agent files were not read. A concrete, checkable item may exist in one
  of them; the divisions read were the ones that bear on the engineering lifecycle.

## 10. Attribution

Anything adapted from the reference repo (the brief fields of M1, the gate-placement criteria of
M2, the check descriptions of A3) must carry: the source path, the commit `8ae6164`, and
"MIT, Copyright (c) 2025 AgentLand Contributors". Nothing is copied by this assessment.
