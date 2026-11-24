# Gates and security governance

## Gates

| Gate | What it checks | Where |
|---|---|---|
| Validator | Folder name equals frontmatter name, links resolve, no orphan references, one outcome vocabulary, cited rule ids exist. Eight invariants in [AGENTS.md](../AGENTS.md). | `node scripts/cli.mjs validate`, CI |
| RED | For security-sensitive work, a failing test proving the secure behaviour exists before any production path is written. | `gate.mjs` |
| PROVE | The repository's own commands, applicable static rules, runtime attacks, docs and UI evidence. | `references/prove.md` |
| Review | Primary review plus second opinion on an identified candidate. | `gate.mjs`, `candidate-id.mjs` |
| Ship-ready | Candidate id unchanged since review, scope and CI checks satisfied before the commit. | `ship-ready-check.mjs`, `check-pr-scope.mjs` |

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

Implementation does not begin until a human approves the plan. The approval is bound to the plan by
digest: `brief.mjs plan-digest` hashes the plan with the run-state body removed, and the digest is
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

Before heavy work, `host-admit.mjs --class heavy` samples memory pressure and load and prints one JSON
line: exit 0 admit, 1 hold, 2 usage error or unsupported platform. It is macOS only; elsewhere it
prints `platform_unsupported`, which is not an allow, and the manual rule applies (check memory and
load, run one heavy job at a time). Memory pressure level 2 is a warning and level 4 holds; the level
4 threshold is a pragmatic choice, not a proven safety boundary.

## Rules of engagement for attacks

Runtime attacks target a local disposable instance. Never production or shared staging. This rule is
load-bearing in `vapt` and in `ship-ticket`.
