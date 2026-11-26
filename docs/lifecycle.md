# Ticket lifecycle

`ship-ticket` takes one ticket key, work item id or URL and produces one branch, one commit and one
pull request. The source of truth for each phase is
[skills/ship-ticket/SKILL.md](../skills/ship-ticket/SKILL.md) and its `references/`.

| Phase | Outcome |
|---|---|
| UNDERSTAND | Full tracker specification (including comments, parents, attachments), detected stack and commands, pinned UI design if any, and a preflight that the independent reviewers can run. |
| PLAN | One complete, repository-grounded plan and Design Contract, debated with the counterpart model by default, then approved by a human. |
| BUILD | Implementation and tests on the ticket branch, by workers with disjoint owned paths; a write outside a worker's set fails that task. |
| PROVE | The repository's own checks, the code-quality rule pass, `vapt` attacks where trust boundaries changed, truthful docs and UI evidence. |
| REVIEW | One bounded primary review workflow plus one mandatory independent second opinion. |
| SHIP | One commit, one push, one pull request, PR CI must pass before the tracker item is completed (orchestrator steps). |

## Invariants worth knowing

- The specification comes from the tracker; it is never reconstructed from code.
- A human approves the plan before implementation. A model critique is advice, not approval.
- Work happens on a ticket branch, never the default branch.
- The approved Design Contract names every file that may change. Another path needs re-approval; the engine detects an out-of-set write after the worker exits.
- The planner classifies security-sensitive work (auth, multi-tenancy, money, secrets) as ELEVATED and
  the person approves it; on engine runs its risk labels require a failing test first.
- A feature must not ship switched off unless the human asked for that.
- After REVIEW passes the candidate bytes do not change; the candidate id is recomputed before commit
  and on resume.

## Review is bounded

In PROVE (with a backstop of 6 corrective rounds per ticket), the Factory collects all failures first, fixes them in one consolidated batch inside the approved scope and re-runs the chain, continuing while each round makes progress; it returns to the owner only after two rounds with no progress, when the approved budget is spent, or when a fix would change requirements, scope, security guarantees or an owner-reserved decision. REVIEW may use one repair batch and one targeted
confirmation of the affected surface only. A failed confirmation is the result, not a new review
cycle. See [model-routing-and-reviews.md](model-routing-and-reviews.md).

## Resume

Run state is append-only and records the approved plan digest. A run resumed after REVIEW has passed
recomputes the candidate identity and performs only the missing idempotent SHIP steps; it never
re-enters REVIEW.

## Plan approval

Where the host provides a native plan mode, the plan is approved through it and that approval is
consumed once. Headless environments use a pending-plan approval fallback and never implement before
approval.
