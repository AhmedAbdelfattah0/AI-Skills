# Cross-model planning and review

Load once, during UNDERSTAND; PLAN (debate) and REVIEW (second opinion) reuse
it, reloading only if it is no longer in context (a fresh session resuming at
PLAN or REVIEW, or after a compaction). [codex-cli.md](codex-cli.md) owns Codex transport details.

## Select from the host

Use the current orchestrator's known identity, not installed binaries or folder
names. Record the selection once:

| Orchestrator | PLAN counterpart (every implementation plan) | REVIEW second opinion (mandatory, every ticket) |
|---|---|---|
| Claude | Codex, else Fable (`carrier.degraded: true`) | fresh Codex session, else fresh Fable session |
| Codex | Claude | fresh Codex session, else fresh Fable session (both differ from the Opus primary) |
| another known host | available different model family, preferring Codex | fresh Codex session, else fresh Fable session |
| unknown | explicitly configured counterpart, otherwise declare identity unavailable | fresh Codex session, else fresh Fable session; do not claim cross-model independence for Fable |

The host drafts, challenges the counterpart's reasoning, and reconciles evidence.
The counterpart critiques and defends or concedes its findings. These are the two
participants; do not launch another copy of the host just to debate. The required
primary REVIEW workflow stays independent of all builders, even if it uses the
host's family. Never reuse a PLAN or BUILD session for REVIEW.

Record `host_agent`, `counterpart_agent`, CLI version, carrier and exact session
ID. The PLAN debate is the default for every implementation plan (a plan with a
Design Contract), STANDARD or ELEVATED. Risk classification alone never skips
it. `SKIPPED` is valid only with an explicit owner-approved exception frozen in
the plan (section 7 "Debate carrier and exceptions requested", below), and the
exception covers this ticket only. The debate requires actual counterpart
participation. If Codex is unavailable or fails after bounded recovery, hold the
same debate with a fresh Fable session as the declared substitute: the attestation
records `carrier: {agent: fable, degraded: true}` and the plan carries the frozen
degradation acknowledgement. That is a same-provider challenge, never cross-model
agreement, and a transport label only: the degraded carrier does not by itself
resolve or waive any finding, and the same convergence, limit and disposition
checks apply (a substitute's verified concession counts exactly like any other). Only if Fable cannot run either
is it `WAIT_FOR_USER`, unless the owner approves an exception. On a Codex host the
counterpart is already a Claude session; if no Claude session can run, that is
`WAIT_FOR_USER` likewise, and Fable stands in only as the declared degraded
carrier. A degraded carrier is never permission to skip the debate. Both profiles get two
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

Send the brief on stdin; set the per-call `--timeout` (PLAN: initial 10 minutes, delta 5 minutes, configurable).
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
node <delegate-skill>/scripts/relay.mjs --cd <repo> --read-only --effort high --timeout <per-call timeout>
```

Send the self-contained brief on stdin; keep relay outputs in their default
temporary directory outside the repo. After process completion read `status`,
`exitCode`, `finalMessage`, and `threadId` (Codex) or `sessionId` (Claude) from
`result.json`. Resume only that exact ID with `--session`, repeating directory,
read-only, effort and timeout flags. Never use a global latest-session resume.
A successful exit alone is not a substantive review.

Use each existing relay's watchdog with the per-call timeout (PLAN) or the
remaining REVIEW budget; native
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
make a forbidden shell write permissible. The carrier is derived from the
host/counterpart pair (Claude host: the Codex relay; Codex host: the Claude relay
or a Claude session; Fable only as the declared substitute). At PLAN start, inside
the actual native Plan Mode context, run the PLAN carrier probe
(`brief.mjs debate-probe`, [codex-cli.md](codex-cli.md) "PLAN carrier probe") and
record its five separate capabilities in the plan header
`codex_route: {dispatch, fresh_result, resume, cancellation, coverage}`, each pass
or fail with a failure class (`permission_denied`, `auth`, `provider`, `relay`).
Coverage is reported as "candidate identity and untracked-content hash unchanged;
ignored files out of coverage", never as an unqualified byte-identical tree.
Capability preflight is split three ways: counterpart dispatch (the probe); the
plan-file attestation edit (the plan file is the one writable file in Plan Mode;
if that edit is denied, planning itself is impossible: `WAIT_FOR_USER`); and the
retained-bundle copy after approval (a failure is `WAIT_FOR_USER` before START).
A host permission prompt is the owner's normal approval. Never ask for a broad
allow rule or a Plan Mode bypass; the only permission you may suggest, as the
owner's choice, is one exact-command rule for the relay invocation. A failed probe
is reported with its class, then the authorized policy follows: the Fable
substitute (a subagent runs inside Plan Mode) with `carrier.degraded: true` and the
frozen acknowledgement; if Fable cannot run either, `WAIT_FOR_USER` or an explicit
owner exception, without exiting Plan Mode early to run anything. The REVIEW probe
is unchanged; this governs only the PLAN probe.

## PLAN debate

Restoration: the default scope (every implementation plan) and the read-only relay
carrier inside native Plan Mode restore the debate as introduced in b2e015b. That
change made PLAN a reciprocal debate (initial challenge, host response, focused
rebuttal to the same counterpart session, concede or defend); it was later narrowed
to security-sensitive tickets for token budget. Evolution (owner-requested,
2026-11-22): evidence-driven stopping instead of the old call/minute cap, the
checkpoint, the plan-resident attestation and digest cycle, the `debate-check` checker and the separate carrier field.
Restoring the relay carrier is the intent, not a proven result: real-relay
compatibility inside native Plan Mode stays unverified until the manual probe in
[codex-cli.md](codex-cli.md) "PLAN carrier probe" passes in a real Plan Mode
session.

Run mechanical prechecks first: paths exist or are explicitly new, commands come
from repository config, no duplicate implementation, and the execution DAG has
complete dependencies, no cycles and disjoint concurrent ownership. Finish the
provider/consumer contract checks in [plan.md](plan.md) before dispatch.

### Stopping policy

There is no default call or minute cap. The plan header records
`budget: {max_rounds: null, max_minutes: null}` (null means none); an owner or
repository override is honoured, and reaching a configured budget is a
`LIMIT_REACHED` escalation. Per-call process safety stays: each relay call gets
its own `--timeout` (initial 10 minutes, delta 5 minutes, configurable), and one
`--session` resume is allowed per timeout; a timeout alone is never a debate limit.

The ledger tracks canonical outstanding findings: one shared ledger, where a
renamed or split finding keeps an alias to its canonical ID, and aliases survive
fresh sessions. A round is productive when it changes a decision, resolves an
uncertainty with evidence, or adds a concrete discriminating check or result
relevant to an open canonical finding; a quoted line that changes none of these is
not evidence. Two consecutive non-productive rounds on the same canonical finding are a diagnostic trigger, never a stop. Climb this ladder: (1) an evidence task
(the host or a read-only agent runs a concrete repository check or scratch
prototype and attaches the result); (2) a fresh counterpart session carrying the
delta and the ledger, recording which strategies already failed; (3) if rounds are
still non-productive, escalate as `UNRESOLVED` with both positions. A legitimately
maintained finding may take more than two exchanges while rounds stay productive.
A blocker or major closes only by the counterpart conceding with evidence or by an
owner disposition, never silently.

The 5-round / 45-minute checkpoint is a progress message and telemetry only: it never stops the debate and never asks for approval. Escalate only for a
genuine unresolved decision, stagnation after a strategy change, or an actual
resource or provider limit. Cost (calls, minutes, tokens when the carrier reports
them) is shown in section 7 as information.

### Initial challenge

Send a complete versioned draft, ticket and ACs, constraints, detected stack and
real commands, precheck results as given, Integration Contract, execution DAG,
risks and exclusions. Ask the counterpart to inspect relevant named files and
challenge feasibility, correctness, requirements, security, contract compatibility
and safe concurrency. Require evidence and concrete alternatives. Do not redo
mechanical prechecks without a specific contrary observation.

Every brief starts with three lines the checker reads, each exactly once:
`request_id: <fresh id>`, `plan_version: <v>` and, for the confirmation round,
`plan_digest: <brief.mjs plan-digest of the frozen plan file>`. A `request_id` is
never reused.

### Host response and focused rebuttal

For each finding the host incorporates it or challenges it with evidence and
reasoning. Send the revised full draft or unambiguous versioned delta, every
finding's disposition and evidence, and host counterproposals to the **same**
counterpart session. Ask it to defend or concede disputed points and verify the
changed design and affected seams, without rereading the whole repository. The
counterpart marks each closed finding in its response header (below) with a line
`finding <ID>: conceded` or `finding <ID>: confirmed`, nothing after the keyword; a
blocker or major counts as closed by the counterpart only when the round it cites
carries that line for the finding's own canonical ID (an alias never closes it).
Agreement on an older draft never transfers automatically to a revised one.

If the Integration Contract changes, recheck affected provider/consumer
compatibility before declaring convergence. No implementation or candidate edits
occur during debate.

### Responses, outcomes and the attestation

Each counterpart response begins with a header: every line before its first blank
line, and only those, is parsed. The header holds `verdict: AGREE` or
`verdict: CHANGES_REQUESTED`, `request_id: <id from the brief>`, `plan_version: <v>`
and `plan_digest: <digest>` (the digest line is required when the brief carried
one), each exactly once from column 1, plus the `finding <ID>: conceded|confirmed`
lines. Any other header line (a fence, an indented or quoted line, prose, a hedged
concession) refuses the response; everything after the first blank line is prose
and never counts as an echo or a concession, so "AGREE for v4" in prose is not an
echo. Findings
follow, at most twelve (blockers and majors first, at most three minors), each with
a stable ID, severity, plan section, repository evidence, consequence and proposed
change; delta responses explicitly concede or defend previous findings, and excess
material findings return `overflow`.

Outcomes, independent of the carrier:

- `CONVERGED` requires the counterpart's confirmation of the exact final plan digest: the last response is `AGREE` for the same `request_id`,
  `plan_version` and `plan_digest`, verified from the retained relay evidence, with
  no open blocker or major in the canonical ledger and changed-contract
  compatibility rechecked. A clean initial critique the host accepts without
  changes still needs that confirmation of the frozen digest.
- `UNRESOLVED`: at least one outstanding canonical finding with both positions. It
  is a valid owner-decision presentation state without the counterpart's `AGREE`
  (the checker never deadlocks a legitimate escalation), but it is not
  debate-qualified for execution: START needs a concrete disposition of every
  outstanding finding.
- `LIMIT_REACHED`, with `limit: {kind: configured_budget | provider_limit | resource_limit, evidence}`:
  the configured value, or the provider/relay error text. The findings list may be
  empty (a first-dispatch quota failure) with `incomplete_review: true`.
  `LIMIT_REACHED` is reported truthfully and is never converted to `CONVERGED`.
- `SKIPPED`: only with the owner exception frozen in the plan.

`DEGRADED` is not an outcome: a substitute carrier is `carrier.degraded: true`.
"Same-provider" is stated only where the identities really share a provider,
computed from `provider:model`, not from the host name.

Freeze section 7 (the human-readable ledger up to the last substantive round and
the predeclared `Attestation: debate-<ticket>-<yyyymmddThhmmZ>` reference) before
the final confirmation request. The terminal data lives outside the digest-hashed
narrative, in the plan file: one line `<!-- debate-attestation-v1 <canonical JSON> -->`
inside the RUN-STATE body, printed by `node scripts/brief.mjs debate-serialize --attestation <json>`
(deterministic and comment-safe; never a line starting with `{`). The attestation
is normalized across carriers: `carrier: {agent, kind: codex_relay | claude_relay | native_session, identity, degraded}`,
and per round `n`, `plan_version`, `request_id`, `status` (the actual
`completed|failed|timeout|aborted|unavailable`), `session_id`, `read_only`, the
relay out-dir as provenance only, bundle-relative `files` with their `sha256`
(`brief.txt`, `result.json`, `events.jsonl` for a relay; the returned message for a
native session), or `dispatch_error: {class, text}` when no result exists. Keep the
relay out-dirs under one scratch bundle root (`--out-dir <bundle root>/r<n>`), and run
every relay with `--cd` set to the repository itself or a registered worktree of it (a
worktree of the base created for the debate is fine; the sandbox is read-only, so the
counterpart cannot change it). A snapshot copy never qualifies.

Run `node scripts/brief.mjs debate-check --plan <frozen plan> --bundle <bundle root> --repo <repo>`
at PLAN preflight, before `ExitPlanMode`. It verifies the evidence hashes (every
evidence file a regular file inside the bundle, no symbolic link), the relay
`status`, exit code (0 for a completed round, in the record and the result), the
non-empty thread or session id bound to the result, read-only on every round (the
Claude relay also needs `authMethod: claude.ai`), the brief and response
`request_id` binding, the outcome rules (section 7 holds exactly one `**Result:**`
line, whose first word must be the attestation outcome) and the frozen exception
and degradation acknowledgements. Section 7 must be fence-free, and its machine-read
lines (`**Result:**`, `Attestation:`, the carrier bullets, the disposition table)
start at column 1. It binds the relay workdir to `--repo`, never to a path the
attestation merely names: the workdir must exist when checked, be the top level of
a Git work tree, and be either the repository's own top level or a worktree the
repository has registered (`git worktree list --porcelain`). Every git query of the
checks and the probe runs with all `GIT_*` overrides removed from its environment.
There is one binding and no snapshot kind: a snapshot copy, a subdirectory, a
missing directory, another repository with identical content, or a hand-made gitdir
whose `commondir` points at the repository is `debate_workdir_unbound`. Residual
(owner-chosen binding): the binding is to the repository, not to a commit or its
content; a registered worktree on another branch, or a dirty work tree, still binds,
because the relay result does not record HEAD. It prints `outcome`, `debate_qualified`, `outstanding`, `pending`,
`carrier`, `diversity` (PLAN-side evidence, same_provider or cross_provider from
`provider:model`; the separate gateReview diversity field, item G, was withdrawn
by owner decision D-15 as optional telemetry outside closure), `attestation_sha256`
and `run_log_metrics`. A refusal is fixed inside Plan Mode. Because the RUN-STATE body is outside the
digest, state `attestation_sha256` in the text accompanying `ExitPlanMode`; START
records it as `debate_attestation_sha256` and `start-check` re-verifies it. Present
outstanding choices through the normal native approval; unresolved product,
security or scope decisions must be explicit in that request. Never invent
consensus or promise an objectively best plan.

After approval and before START, copy the bundle byte-for-byte to the retained
locator `<git-common-dir>/ai-skills/ship-ticket/debate/<TICKET>/<debate-id>/` (every
component from the git common dir down is a real directory, never a symbolic link;
`debate-retain` and `start-check` both check it with lstat) with
`node scripts/brief.mjs debate-retain --plan <plan> --bundle <bundle root> --repo <repo>`.
References inside the attestation are relative to the bundle root; the original
out-dir paths are provenance only and never locate evidence, so `start-check` in a
new session verifies from the retained bundle after the scratch directories are
gone. A failed copy is `WAIT_FOR_USER`, never a START without the retained
evidence. Every newly approved implementation plan carries `debate_policy: 2`; for
it the attestation hash and resolvable evidence are mandatory. A plan without
`debate_policy` is legacy only when its START was approved before the S4 cutoff
(`DEBATE_POLICY_CUTOFF` in `brief.mjs`, finalized at merge).

An `UNRESOLVED` or `LIMIT_REACHED` plan may START only when every outstanding
canonical finding (and, for `LIMIT_REACHED`, the limit itself as row `LIMIT`) has a
concrete disposition in the approved digest: `accept_risk` with the accepted-risk
text, `decided` with the actual decision, or `waived` with the frozen exception.
`decide` or `re-debate` without the resolution is pending and blocks START
(`debate_disposition_pending`). The Design change cell is exactly `yes` or `no`;
anything else is pending. A design-changing disposition (`yes`) needs a new
`plan_version`, the counterpart's AGREE for the new digest, then native approval
again (`debate_reconfirm_required`). A finding the attestation records as closed by
the owner goes through the same disposition validation. Populated names or timestamps are
never proof of authorization. Documented limit: this detects inconsistency, replay
and stale or unrelated results; it cannot authenticate against a host able to
fabricate every input. A provider or resource limit quotes one whole diagnostic entry
of the last attempt (the relay `error`, an error event, or the dispatch error; never
a counterpart message or event), and that entry's class must match the limit kind:
an entry naming both provider and permission words is ambiguous and supports
neither. Host-trust residual, the same property as
`SECURITY_POLICY_CUTOFF` in engine-dag.mjs: a new plan without `debate_policy`
whose START `approved_at` is backdated before `DEBATE_POLICY_CUTOFF` passes as
legacy, because the host writes `approved_at`; no new mechanism closes that. Engine
`init` does not enforce debate qualification yet (a recorded follow-up);
`start-check` is the workflow gate.

Remain in native Plan Mode throughout. Per-round measurements live in the
attestation, never in logger writes during Plan Mode
([observability.md](observability.md)). Progress messages and counterpart
completion continue automatically to the next exchange or the single approval
handoff. Do not ask the user to referee each turn.

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
