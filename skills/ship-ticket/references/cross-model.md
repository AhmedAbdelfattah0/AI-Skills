# Cross-model planning and review

Load once, during UNDERSTAND; PLAN (debate) and REVIEW (second opinion) reuse
it, reloading only if it is no longer in context (a fresh session resuming at
PLAN or REVIEW, or after a compaction). [codex-cli.md](codex-cli.md) owns Codex transport details.

## Select from the host

Use the current orchestrator's known identity, not installed binaries or folder
names. Record the selection once:

| Orchestrator | PLAN counterpart (security-sensitive work only) | REVIEW second opinion (mandatory, every ticket) |
|---|---|---|
| Claude | Codex, else Fable (`DEGRADED`) | fresh Codex session, else fresh Fable session |
| Codex | Claude | fresh Codex session, else fresh Fable session (both differ from the Opus primary) |
| another known host | available different model family, preferring Codex | fresh Codex session, else fresh Fable session |
| unknown | explicitly configured counterpart, otherwise declare identity unavailable | fresh Codex session, else fresh Fable session; do not claim cross-model independence for Fable |

The host drafts, challenges the counterpart's reasoning, and reconciles evidence.
The counterpart critiques and defends or concedes its findings. These are the two
participants; do not launch another copy of the host just to debate. The required
primary REVIEW workflow stays independent of all builders, even if it uses the
host's family. Never reuse a PLAN or BUILD session for REVIEW.

Record `host_agent`, `counterpart_agent`, CLI version, carrier and exact session
ID. The PLAN debate is required only for security-sensitive work (the spine's
"Security sensitivity": auth, multi-tenancy, billing, payments, money, secrets),
not for every ELEVATED ticket; every other ticket records
`plan_debate.status: SKIPPED` with the reason. When the debate runs, it requires
actual counterpart participation. If Codex is unavailable or fails after bounded
recovery, hold the same bounded debate with a fresh Fable session and record
`plan_debate.status: DEGRADED`, `counterpart_agent: fable`: a same-provider
challenge, never cross-model agreement. Only if Fable cannot run either is it
`WAIT_FOR_USER`, unless the user explicitly authorizes solo planning. On a Codex
host the counterpart is already a Claude session (Fable qualifies); if no Claude
session can run, that is `WAIT_FOR_USER` likewise. Never treat
`DEGRADED` as permission to skip a required debate. Both profiles get two
reviewers: the primary workflow plus the mandatory second opinion; ELEVATED
changes partitioning and the required security outcome, not the reviewer count.
Human approval remains the PLAN gate.

## Read-only carriers

Discover delegate skills by name, not sibling-relative paths. Read the installed
transport instructions and relay `--help`. Use only read-only dispatch/result
mechanics here, not the delegates' implement-and-land workflows.

- **Codex:** PLAN needs `codex-delegate` and `codex --version`; REVIEW can use
  the binary with a verified watchdog/cancellation route, or the existing relay.
  Follow [codex-cli.md](codex-cli.md).
- **Claude:** use `claude-delegate`'s read-only relay, `claude --version` and
  `claude auth status`. A missing relay makes that route unavailable. A check
  blocked by the host sandbox is not proof of logout; follow the host's normal
  permission process, never bypass permissions.

### Claude CLI authentication, not a separate API integration

Use the installed `claude-delegate/scripts/relay.mjs`, which launches
`claude -p --output-format stream-json --verbose`. Do not replace it with an
Anthropic SDK, HTTP request, API-key setup or a request to buy API credits.
The CLI can itself select API-key billing, so launching `claude` alone does not
prove that it uses the user's subscription.

For the subscription route, check authentication in the **same child environment
and permission context** used for dispatch and resume. Omit `ANTHROPIC_API_KEY`
and `ANTHROPIC_AUTH_TOKEN` from that child environment only; preserve the user's
OAuth login, HOME and runtime paths. Never print credential values or edit global
shell profiles, credential files or account settings. If a custom endpoint,
third-party provider or `apiKeyHelper` still selects another authentication route,
report that conflict instead of sending a paid request through it.

For POSIX shells, the explicit preflight/dispatch shape is:

```bash
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN claude auth status
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN \
  node "<installed-claude-delegate>/scripts/relay.mjs" \
  --cd "<target-repo>" --read-only --effort high --timeout 10m
```

Send the brief on stdin; replace the timeout with the remaining debate budget.
For a reply, add `--session <sessionId>` with the same environment and flags.
On Windows, construct a copied child environment in Node, delete those two keys,
and spawn the same installed relay with argument arrays; do not mutate persistent
environment settings. Keep only safe authentication metadata in reports:
`loggedIn`, `authMethod`, `apiProvider`, `subscriptionType` (when supplied).
Require successful subscription authentication (`authMethod: claude.ai` on the
verified CLI), not merely `loggedIn: true` with `authMethod: api_key`.

On macOS, a Codex sandbox can block the CLI's Keychain access and incorrectly
make the subscription look logged out. Retry the sanitized auth check, and the
read-only relay dispatch if needed, through the host's normal escalation approval.
Keep `--read-only`; host escalation is not Claude permission bypass. If login
still fails, ask the user to authenticate their CLI. If subscription usage itself
is exhausted, report the actual CLI result and pause; do not infer API billing
from the word “credits” alone. This auth behavior follows the
[Claude authentication documentation](https://code.claude.com/docs/en/authentication).

Both relays accept this shape, using the discovered absolute skill path:

```text
node <delegate-skill>/scripts/relay.mjs --cd <repo> --read-only --effort high --timeout <remaining-budget>
```

Send the self-contained brief on stdin; keep relay outputs in their default
temporary directory outside the repo. After process completion read `status`,
`exitCode`, `finalMessage`, and `threadId` (Codex) or `sessionId` (Claude) from
`result.json`. Resume only that exact ID with `--session`, repeating directory,
read-only, effort and timeout flags. Never use a global latest-session resume.
A successful exit alone is not a substantive review.

Use each existing relay's watchdog with the remaining phase budget; native
timed polling is not equivalent to process cancellation. Preflight actual
cancellation and completion reporting before promising a bounded review. Do not
start a second timeout framework around a relay that already enforces it. Detect
carrier timing fields for the installed version, retain actual start/finish and
collection delay separately from logger timestamps, and never infer execution
duration from when several results were collected together. See
[observability.md](observability.md) for telemetry provenance and privacy.

Claude's relay allows only Read, Glob and Grep in plan permission mode; it cannot
run Git or tests. Supply the actual merge-base-to-working-tree diff (including
staged changes), changed-path list, deleted/renamed paths, untracked-file contents
or readable paths, and proof results. A diff command alone is insufficient.
Include load-bearing AGENTS.md constraints because Claude does not generically
load that file. For large diffs use a readable temporary artifact; do not omit
changes to fit the prompt. See the [Claude CLI reference](https://code.claude.com/docs/en/cli-reference)
for the underlying permission and tool flags.

Claude's `readOnlyViolation` is a tripwire, not an OS boundary; hooks can still
write. Verify the worktree before/after dispatch; `null` means incomplete
coverage. During REVIEW recompute candidate identity and follow changed-candidate
handling. Never authorize edits, nested agents, commits or tracker operations in
a reviewer brief.

Host Plan Mode restrictions also apply to the carrier. Temporary files do not
make a forbidden shell write permissible. Preflight a permitted read-only carrier
before entry; if invocation is blocked, use the Fable fallback above (a
subagent runs inside Plan Mode), and `WAIT_FOR_USER` only when that is blocked
too, without exiting early to run it.

## PLAN debate

Run mechanical prechecks first: paths exist or are explicitly new, commands come
from repository config, no duplicate implementation, and the execution DAG has
complete dependencies, no cycles and disjoint concurrent ownership. Finish the
provider/consumer contract checks in [plan.md](plan.md) before dispatch.

Default budget: **three counterpart calls maximum and 20 minutes total**
from first dispatch through host reconciliation. Record any repository/user
override before dispatch. The initial call gets at most 10 minutes; delta calls
at most 5 minutes each, always capped by remaining total time. One timeout
recovery may take at most 2 minutes, consumes a response slot and the same total
budget. Count every attempted call, even if no response arrives. Missing sessions,
invalid output and recovery never reset either limit.

### Initial challenge

Send a complete versioned draft, ticket and ACs, constraints, detected stack and
real commands, precheck results as given, Integration Contract, execution DAG,
risks and exclusions. Ask the counterpart to inspect relevant named files and
challenge feasibility, correctness, requirements, security, contract compatibility
and safe concurrency. Require evidence and concrete alternatives. Do not redo
mechanical prechecks without a specific contrary observation.

### Host response and focused rebuttal

For each finding the host incorporates it or challenges it with evidence and
reasoning. Send the revised full draft or unambiguous versioned delta, every
finding's disposition and evidence, and host counterproposals to the **same**
counterpart session. Ask it to defend or concede disputed points and verify the
changed design and affected seams, without rereading the whole repository.
Agreement on an older draft never transfers automatically to a revised one.

Use another response slot only for unresolved material findings or material
changes. If the Integration Contract changes, recheck affected provider/consumer
compatibility within the same total budget before declaring convergence. No
implementation or candidate edits occur during debate.

### Stop and present

Each counterpart response names `plan_version`, `round`, and
`AGREE | CHANGES_REQUESTED`, with at most twelve findings (blockers/majors first,
at most three minors). Each finding has a stable ID, severity, plan section,
repository evidence, consequence and proposed change. Delta responses explicitly
concede or defend previous findings. Excess material findings return `overflow`.

`CONVERGED` means both participants accept the **same final draft**, material
findings are resolved with evidence, and changed contract compatibility is
checked. A clean initial critique accepted by the host without changes ends
after one response. Do not manufacture debate to fill the budget.

At the response/time cap, repeated disagreement without new evidence, or overflow,
stop debate and record `UNRESOLVED`: the best reconciled draft, remaining IDs and
both positions. Unavailable/invalid/timed-out Codex transport switches to the
Fable fallback above and records `DEGRADED` with what was actually reviewed; if
Fable fails too, pause for recovery or an explicit solo-plan waiver. Ordinary
approval of a draft does not implicitly waive a missing debate.
Never invent consensus or promise an objectively
best plan. Present outstanding choices through the normal human plan approval;
unresolved product/security/scope decisions must be explicit in that request.
Implementation still requires human approval of the final design.

Section 7 records identities, versions, session ID, call and response counts, start/end
times, dispositions and final status. Remain in native Plan Mode when available.
Progress messages and counterpart completion continue automatically to the next
exchange or the single approval handoff. Do not ask the user to referee each turn.

## REVIEW second opinion

The second opinion is mandatory on every ticket, STANDARD and ELEVATED alike.
Start it concurrently with the required primary workflow when resources allow,
using a **fresh session**, the frozen candidate ID and the scope packet in
[review.md](review.md). Give it the approved plan and factual proof evidence;
omit section 7's debate transcript/dispositions from the review brief and ask
reviewers to skip that section when reading the plan. Do not supply the primary
findings to it. It returns at most twelve actionable findings, at most three
minors, each with `file:line`, quoted evidence, consequence and fix shape.
Excess material findings set `overflow: true`.

Route, in order:

1. **Codex** in a fresh session, when available and within quota (preferred, on
   any host): `second_opinion: codex`, identity `codex:<model>`, 10-minute
   budget.
2. Otherwise a fresh **Fable** session (`second_opinion: fable`, identity as
   recorded under "Dispatching Fable" below), on its own 10-minute budget, run after Codex is unavailable,
   fails, times out or reports its usage limit. Record it accurately as a
   same-provider independent review, never as cross-provider or cross-model
   agreement. The gate accepts it because it differs from the Opus primary by
   `provider:model`; a builder recorded as `claude:provider-default` would make
   it `reviewer_is_builder`, so map builder tiers to explicit models.
3. If neither Codex nor Fable produces a usable result, `WAIT_FOR_USER`. Never
   continue on primary coverage alone.

**Dispatching Fable.** On a Claude host, start a new subagent with `model: fable`
and no PLAN, BUILD or primary-review context: the same frozen scope packet,
read-only, on its own 10-minute budget. Elsewhere use the `claude-delegate`
read-only relay with the Fable model selected. Record the model id the carrier
reports (`claude:fable-<version>`), or `claude:fable` when it reports none. The
identity must differ from every builder identity, and the gate compares
`provider:model`, so an unversioned `claude:fable` does not catch a builder
recorded as `claude:fable-<version>`: if any builder ran on Fable, Fable cannot be
the second opinion (use Codex, or `WAIT_FOR_USER`). Likewise on a Codex host whose builders ran
Codex, the Codex second opinion must be a model no builder used; otherwise use
Fable.

**CodeRabbit is optional extra coverage**: it may run on the same candidate
(`coderabbit review --agent --include-untracked` or the CLI's equivalent), and
its findings are reconciled like any other's, but it is never required and never
a fallback that blocks. The one exception is engine-enforced: a risky unit's
review with `config.unitReview` needs a provider other than the primary's (see
[units.md](units.md)).

If the primary finishes first, wait for the second opinion within its budget.
Verify the cancellation route before launch; an advisory prompt is not a
watchdog. If the Codex carrier cannot enforce its budget or be stopped, treat
Codex as unavailable and run Fable.

Reconcile under [review.md](review.md). Planning debate does **not** apply to code
review: retain one repair batch and one targeted primary confirmation. PR-side
bot findings are follow-up input, never an automatic restart of completed REVIEW.
