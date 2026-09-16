# Cross-model planning and review

Load during UNDERSTAND for selection, PLAN for debate, and elevated REVIEW for
the second opinion. [codex-cli.md](codex-cli.md) owns Codex transport details.

## Select from the host

Use the current orchestrator's known identity, not installed binaries or folder
names. Record the selection once:

| Orchestrator | PLAN counterpart | Elevated REVIEW second opinion |
|---|---|---|
| Claude | Codex | fresh Codex session |
| Codex | Claude | fresh Claude session |
| another known host | available different model family, preferring Codex | fresh session of that family |
| unknown | explicitly configured counterpart, otherwise declare identity unavailable | do not claim cross-model independence |

The host drafts, challenges the counterpart's reasoning, and reconciles evidence.
The counterpart critiques and defends or concedes its findings. These are the two
participants; do not launch another copy of the host just to debate. The required
primary REVIEW workflow stays independent of all builders, even if it uses the
host's family. Never reuse a PLAN or BUILD session for REVIEW.

Record `host_agent`, `counterpart_agent`, CLI version, carrier and exact session
ID. PLAN requires actual counterpart participation: unavailable capability or a
failed dispatch is `WAIT_FOR_USER` after bounded recovery, unless the user
explicitly authorizes solo planning. Record `DEGRADED` for diagnostics, but never
treat that label as permission to skip the debate. The optional REVIEW opinion
retains its separate fallback policy. Never substitute the same family and claim
cross-model agreement. STANDARD
retains one primary workflow; an explicit request for two code reviewers selects
ELEVATED. Human approval remains the PLAN gate.

## Read-only carriers

Discover delegate skills by name, not sibling-relative paths. Read the installed
transport instructions and relay `--help`. Use only read-only dispatch/result
mechanics here, not the delegates' implement-and-land workflows.

- **Codex:** PLAN needs `codex-delegate` and `codex --version`; REVIEW can use
  the binary alone. Follow [codex-cli.md](codex-cli.md).
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
before entry; if invocation is blocked, use `WAIT_FOR_USER` for the required
carrier or explicit solo-planning choice, without exiting early to run it.

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
both positions. Unavailable/invalid/timed-out transport means `DEGRADED`, with what
was actually reviewed recorded, and pauses for recovery or an explicit solo-plan
waiver; ordinary approval of a draft does not implicitly waive the missing debate.
Never invent consensus or promise an objectively
best plan. Present outstanding choices through the normal human plan approval;
unresolved product/security/scope decisions must be explicit in that request.
Implementation still requires human approval of the final design.

Section 7 records identities, versions, session ID, call and response counts, start/end
times, dispositions and final status. Remain in native Plan Mode when available.
Progress messages and counterpart completion continue automatically to the next
exchange or the single approval handoff. Do not ask the user to referee each turn.

## REVIEW second opinion

On ELEVATED, start the counterpart concurrently with the required primary
workflow, using a **fresh session**, frozen candidate ID and the scope packet in
[review.md](review.md). Give both the approved plan and factual proof evidence;
omit section 7's debate transcript/dispositions from the review brief and ask
reviewers to skip that section when reading the plan. Do not supply the primary
findings to the counterpart.
It returns at most twelve actionable findings, at most three minors, each with
`file:line`, quoted evidence, consequence and fix shape. Excess material findings
set `overflow: true`.

The existing 10-minute optional budget includes any one CodeRabbit fallback.
Fallback runs only while the primary is still running and within the remaining
budget; otherwise declare `DEGRADED`. If the primary finishes first, collect an
already-completed counterpart result or cancel the optional process and declare
incomplete coverage. Never add an optional serial tail. Name CodeRabbit as a
fallback, not as Claude/Codex agreement.

Reconcile under [review.md](review.md). Planning debate does **not** apply to code
review: retain one repair batch and one targeted primary confirmation. PR-side
bot findings are follow-up input, never an automatic restart of completed REVIEW.
