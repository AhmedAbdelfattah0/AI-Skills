# Production

Load during PRODUCE. Output: a rendered revision, its snapshot and a decision
log entry for every provider choice.

## Render

`check` runs the gates; `render` refuses to start while any gate blocks.
`render` bundles the skill's composition with the run's `assets/` as its only
public directory, renders `previews/r<N>.mp4`, collects measured text layout
into `reports/r<N>/layout.json`, and snapshots into `project/r<N>/`: the
composition source, `package.json` and lockfile, resolved project config,
timeline, the manifest subset used, render settings, a globals digest and one
hash per shot. A changed timeline needs a new `revision`; re-rendering the same
revision needs `--force`.

System fonts on the rendering machine are a reproducibility limitation; a
brand font must be installed or supplied, and is recorded.

## Execution and provider choice

For every capability a shot needs (capture, voice, generated scene, render),
compare the feasible methods and record the choice:

| Method | Use when | Cost check |
|---|---|---|
| Local (renderer, `say`, captures) | default for real UI, motion, assembly | zero incremental cost; still record rights |
| Browser (user's existing account) | a service has no usable API or the user's plan includes the feature | verify included credits and the service's terms; ask before any consuming click |
| Free or included API | verified quota, commercial rights and reliability | record the quota evidence |
| Paid API | never required for the core path | approval with unit, cap and retry ceiling before the first call |

Compare quality, incremental cash, remaining included credits, manual steps,
reliability, time and commercial rights. Prefer the zero-cost path that meets
the quality bar; when a paid path is clearly better, present the trade-off
instead of spending an hour automating around a trivial fee. Append one
`decisions.jsonl` line: `{type: "provider", capability, chosen, rejected:
[{method, reason}], incrementalCost, status}`.

## Spend procedure

1. Estimate cost in the provider's unit; show provider, scope, unit, cap and
   retry ceiling; ask.
2. Record the user's answer verbatim in `approvals.json` (`decidedBy: user`).
3. Before every consuming action — API call or browser click — re-read the
   approval: remaining = cap − consumed − reserved. Not enough → stop and ask.
4. After the action, record `consumed` and the asset's `provenance.cost` and
   `approvalId`.
5. An ambiguous outcome (timeout, unclear charge) sets the approval to
   `needs-reconciliation`; no retry until the user or the provider's records
   settle it.

Scripts enforce steps 2 and 5 for ingested assets; step 3 for browser clicks
is procedural and is yours to follow every time.

## Voice

| Provider | Status | Notes |
|---|---|---|
| none | always | captions carry the message |
| `say` (macOS) | built | `voice --provider say --voice <name> --rate <wpm>`; Arabic is Majed (MSA), not Egyptian; commercial rights unverified → draft |
| any other | not built | add only after the user picks one; record rights and cost |

A slower voice is a new `voice` take with a lower `--rate`, a new asset ID and
re-sized shots — never time-stretching that alters pitch.
`say` applies rates in coarse steps (for Majed, 120 and 140 sound identical);
compare the measured duration with the previous take and report the actual
change rather than the requested rate.

## Generated scenes

Only for clearly labeled cinematic or conceptual shots, never product UI or a
workflow the product does not have. Each needs provenance, rights and, if it
costs anything, an approval. If no provider is available or approved, say so
and keep the video to real footage and cards.

## Browser-operated providers

Per provider: confirm the user has access and the terms permit automated use;
open the service in the user's browser session; pause for login/MFA/CAPTCHA;
ask before any consuming click; download the result; ingest it as
`generated` with cost and approval. Not yet built or verified for any provider.
