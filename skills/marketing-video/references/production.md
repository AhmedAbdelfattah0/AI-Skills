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
| A take the user generates by hand on a provider's website | built | `ingest --kind voice --method provided --provider … --text …`; rights per that provider's plan evidence |
| `say` (macOS) | built | `voice --provider say --voice <name> --rate <wpm>`; Arabic is Majed (MSA), not Egyptian; commercial rights unverified → draft |
| any other | not built | add only after the user picks one; record rights and cost |

A slower voice is a new `voice` take with a lower `--rate`, a new asset ID and
re-sized shots — never time-stretching that alters pitch.
`say` applies rates in coarse steps (for Majed, 120 and 140 sound identical);
compare the measured duration with the previous take and report the actual
change rather than the requested rate.

## Music

`ingest --kind music` (method `provided` or `generated`), then `timeline.music`.
The composition ducks the music to `duckVolume` under every voice line with a
short ramp and fades it in and out; QA-MIX measures the final mix and fails
unless the quietest voice line is at least 6 dB above the loudest music-only
passage. Music needs its own rights evidence like any asset; a library track's
licence, a provider's plan terms, or "generated locally" for a placeholder.

## Wide screens in a vertical video

A desktop capture is far wider than a 9:16 frame. Crop recordings to the app
window (`sanitize --crop`), open a shot with `"fit": true` and zoom over most
of the shot (`moveFrames`), and match the end framing of one shot to the start
of the next when they crossfade. Large zoom ratios done quickly look jumpy;
the best fix is a capture from a narrower browser window.

## Generated scenes

Only for clearly labeled cinematic or conceptual shots, never product UI or a
workflow the product does not have. Each needs provenance, rights and, if it
costs anything, an approval. If no provider is available or approved, say so
and keep the video to real footage and cards.

## Browser-operated providers

Operating a provider's website for the user (voice, generative video, any
service) is decided per provider from its own current terms, never assumed
from the fact that the user could click the same buttons by hand. Read the
provider's terms, usage policy and any API terms; record the result in
`project.json` `providers.<name>.browserAutomation` (see contracts) with dated
evidence links. Classify each activity separately, because they differ:

| Activity | What to look for |
|---|---|
| Ordinary operation of the official UI for the user | an express permission, an express ban on assistants/automation, or neither (ambiguous) |
| Automated extraction or scraping | bans on bots/scrapers/data extraction; robots.txt |
| Circumventing limits | bans on evading usage limits, plan restrictions, guardrails |
| Commercial licensing | plan-based rights, generation-time rules, attribution |
| Technical limits | extension site permission, login/MFA/CAPTCHA, downloads |

Operate a provider UI only when its status is `permitted`, or when it is
`ambiguous` and the user has approved one scoped session for that provider
and one approved generation (`provider-ui-session` in approvals.json). That
approval is the user's informed risk decision: it never changes the provider's
status and is never standing permission. Every session: the user's own
account, the user present, the user handles login, MFA and ordinary CAPTCHA,
official UI controls only, one approved generation, ordinary credits, no
network replay, no credential handling. A paywall, a denial or an explicit
anti-automation challenge ends the session; never work around it.

When the status is `ambiguous` or `unknown`, the default is human-assisted:
you prepare the exact text, the user generates and downloads, and you ingest
the file (`ingest --kind voice --method provided`). Offer to draft a written
clarification request to the provider. No provider-specific automation code is
built into this skill.
