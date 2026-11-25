# Gates and security governance

## Gates

| Gate | What it checks | Where |
|---|---|---|
| Validator | Folder name equals frontmatter name, links resolve, no orphan references, one outcome vocabulary, cited rule ids exist. Eight invariants in [AGENTS.md](../AGENTS.md). | `node scripts/cli.mjs validate`, CI |
| RED | On engine runs, where the plan's risk labels or `redSpecs` require it, the engine runs the spec and accepts only an assertion failure before production code. In the hand-run flow the RED line is recorded by the orchestrator. | `gate.mjs` |
| PROVE | The repository's own commands, applicable static rules, runtime attacks, docs and UI evidence. | `references/prove.md` |
| Review | Primary review plus second opinion on an identified candidate. The gate validates the review records it is given (structure, freshness, distinct recorded identities); the reviews themselves are run by the orchestrator. | `gate.mjs`, `candidate-id.mjs` |
| Ship-ready | Candidate id unchanged since review, risk evidence present and the plan's test commands re-run by the engine before the commit. CI is checked after the pull request exists (orchestrator step). | `gate.mjs` (`gate ship-ready`); `ship-ready-check.mjs` cross-checks recorded ship-ready lines; `check-pr-scope.mjs` checks scope |

Outcomes use one vocabulary (`PASS`, `FAIL`, `NOT_TRIGGERED`, `NOT_APPLICABLE`, `DEGRADED`), defined
in exactly one file so a failure is always recordable.

## Two security layers

| Layer | When | Method |
|---|---|---|
| `code-quality` backend rules (`BE-SEC-*`, `BE-AUTH-*`, `BE-TEN-*`) | On the diff, in the rule pass | Static: the control exists in the file. |
| [`vapt`](../skills/vapt/SKILL.md) (`VAPT-API-*`, `WEB-*`, `CFG-*`, `ABUSE-*`) | In PROVE, or as an audit of shipped code | Attacks a local instance: the control engages. Leaves committed tests. |

`vapt` is scoped by trust boundaries, not files. Its control catalog is machine-readable in
`skills/vapt/controls.json` and `controls.test.mjs` fails when the tables and the catalog disagree.
The business-abuse class has no static mirror, so a committed runtime test is its only proof.

## Approval boundary

Implementation does not begin until a person approves the plan, through the host's plan mode. The
approval is bound to the plan by digest, so a later change is detected: `brief.mjs plan-digest` hashes the plan with the run-state body removed, and the digest is
recorded in the START event. For security work the plan also records the `vapt` catalog digest it was
approved against, and each selected boundary and control pair needs a named spec.

## Digest binding

| What | Pinned by |
|---|---|
| Approved plan | `approved_plan_digest` (sha256) |
| Security selection | catalog digest and a selection digest over every surface |
| Reviewed code | candidate id: hash of the final state of every changed and untracked path against the merge base |
| Vendored third-party code | `UPSTREAM.json` hashes checked by a test before import |

## Host admission

Before heavy work, the orchestrator runs `host-admit.mjs --class heavy`, which samples memory pressure and load and prints one JSON
line: exit 0 admit, 1 hold, 2 usage error or unsupported platform. It is macOS only; elsewhere it
prints `platform_unsupported`, which is not an allow, and the manual rule applies (check memory and
load, run one heavy job at a time). Memory pressure level 2 is a warning and level 4 holds; the level
4 threshold is a pragmatic choice, not a proven safety boundary. The CLI does not report provider
errors itself. Inside the engine, parallel work is separately limited by an estimate-based memory
and CPU admission.

## Rules of engagement for attacks

Runtime attacks target a local disposable instance. Never production or shared staging. This is a
rule of engagement that `vapt` and `ship-ticket` give the agent; no script inspects the attack target.
