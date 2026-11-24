# Model routing and reviews

## Tiers

The harness uses four labels, `economy`, `balanced`, `strong` and `inherit`. They are labels the host
maps to real model ids. REVIEW, any high-risk node (`security`, `auth`, `tenancy`, `payments`,
`migration`, `schema`, `shared-contract`, `concurrency`) and high-complexity nodes are always
`strong`; a cheaper request cannot override that. Low-complexity nodes may use a cheaper tier;
everything else inherits the host model. On the carrier, `strong` needs a verified model mapping or
dispatch is refused. Source: `skills/ship-ticket/references/execution-harness.md`.

## Planning debate

By default every implementation plan is debated with the opposite model: a Claude host uses Codex and
a Codex host uses Claude. The host drafts, the counterpart challenges, and the same counterpart
session defends or concedes. `CONVERGED` needs the counterpart's agreement on the exact final plan
digest as a schema-validated object; anything else, including a provider failure, is `UNRESOLVED`
and goes to the human approval rather than being treated as consensus. When Codex is unavailable, a fresh session of the other available model stands in as a declared
degraded carrier (`carrier.degraded: true`). Skipping the debate needs an
explicit owner exception recorded in the plan.

## Review chain

1. One independent primary review workflow checks acceptance criteria, behaviour, applicable rules
   and triggered parity or security outcomes. A material full-stack diff may be partitioned inside
   that one workflow; it is not several full reviews.
2. One mandatory second opinion in a fresh session on every ticket.
3. Accepted findings form at most one consolidated repair batch; only the affected surface gets one
   targeted confirmation.

CodeRabbit is optional extra coverage and never required.

## The second opinion today

The preferred second opinion is Codex in a fresh session. When Codex is unavailable or out of
quota, a fresh session of a different model from the same provider is used instead. That is a
**same-provider** independent review and is recorded as such; it is never reported as cross-provider
agreement. If neither can run, the run pauses rather than skipping the review.

## Why this shape

Review used to have no terminating condition: every repair fed the same probabilistic reviewer. The
rewrite gives one discovery pass, one repair barrier and one terminal verdict. The history is in
[KNOWN-ISSUES.md](../KNOWN-ISSUES.md).
