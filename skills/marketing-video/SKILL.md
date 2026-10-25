---
name: marketing-video
description: |
  Produce a factual marketing video (Reel, feature demo, tutorial) for any
  product from real screen recordings, screenshots and approved assets: plan
  the shots against verified claims, render an editable timeline locally,
  add captions and optional voice, prove the output with measured QA and
  independent review of the actual frames, then revise from natural-language
  notes while preserving approved shots. First capability of the AI Marketing
  Studio. Never fabricates product UI, never spends money or credits without
  explicit approval, never publishes.

  Trigger for /marketing-video, /mv, "make a marketing video", "make a reel
  for <product>", "feature demo video", "turn these screenshots/this
  recording into a video", "promo video for this feature", or a revision note
  on a video this skill produced ("shorten the intro", "zoom on Add Product",
  "slow down the voice").
  Do not use for: social images or carousels, standalone ad copy, publishing
  to a platform, or editing arbitrary footage with no product claim.
---

# /marketing-video — factual product video, locally rendered

The user is the creative director. You collect sources, plan, produce,
prove and revise; the user approves material creative choices, any spend,
and the final video. Product configuration (brand, prohibited claims,
providers) lives in the run's project folder, never in this skill.

## Invariants

- **Real product, real pixels.** Product UI comes only from recordings and
  screenshots of the product. A screenshot may be panned, zoomed, cropped,
  highlighted and captioned; it never gets a synthetic cursor, click, typing
  or any implied interaction — the gates reject those fields. Generated
  footage is labeled on screen and never depicts product UI.
- **Every word is classified.** Each caption, overlay and voice line is
  `factual`, `conceptual`, `cta`, `brand` or `neutral`. A factual line cites a
  claim verified against evidence; a conceptual line is labeled on screen and
  may not sit on real footage. Structural gates are not semantic proof — the
  independent reviewers check meaning.
- **Originals stay restricted.** Inputs are copied into `restricted/` (which
  ignores itself in Git) and only sanitized, hash-attested derivatives in
  `assets/` reach the timeline, reviewers or a package.
- **No silent cost.** Local work is the default. A paid call, a credit-consuming
  click, a purchase or a subscription needs a recorded user decision first;
  a browser subscription is not blanket permission to spend its credits.
- **Unknown rights mean draft.** Any asset or tool without verified commercial
  use keeps the delivery a draft.
- **Independent review of actual output is required.** Both an independent
  Claude reviewer and Codex review the rendered evidence; without them the
  video stays a draft. Nobody approves their own work.
- **Never publish.** Delivery is a local package; publishing needs a separate,
  explicit instruction outside this skill.

## Lifecycle

| Phase | Done when | Load |
|---|---|---|
| **DISCOVER** | project, audience, platform, goal, language, duration, brand, budget and available tools known; preflight run | [contracts.md](references/contracts.md) |
| **ACQUIRE** | every source ingested with provenance and rights, privacy attested or sanitized | [acquisition.md](references/acquisition.md) |
| **PLAN** | claims verified, timeline drafted, counterpart critique reconciled, user approved material creative or cost choices | [creative-planning.md](references/creative-planning.md) |
| **PRODUCE** | gates pass, revision rendered, snapshot written | [production.md](references/production.md) |
| **PROVE** | `verify` passes on the exact MP4; evidence frames extracted | [quality-gates.md](references/quality-gates.md) |
| **REVIEW** | Claude and Codex reviews of the frames recorded; findings fixed in one batch and re-verified | [review-and-revision.md](references/review-and-revision.md) |
| **DELIVER** | package built; user has watched the preview and approved, or the package is labeled draft | [delivery.md](references/delivery.md) |
| **REVISE** | a note mapped to shots, new revision rendered, compare proves unaffected shots preserved | [review-and-revision.md](references/review-and-revision.md) |

Ask only what the sources cannot answer. Choose the minimum sufficient
acquisition path; request missing footage rather than inventing it.

## Running it

`<skill-dir>` is the folder containing this file. Node 20+ is required.
Dependencies (Remotion, React) install once into a lockfile-keyed user cache,
never into the user's project; the renderer's bundled ffmpeg/ffprobe are used,
so no system ffmpeg is needed.

```text
node "<skill-dir>/scripts/mv.mjs" preflight [--install]
node "<skill-dir>/scripts/mv.mjs" init --project <id> --run <run-id> [--root <dir>]
node "<skill-dir>/scripts/mv.mjs" ingest | attest | sanitize | voice | check | render | verify | compare
node "<skill-dir>/scripts/mv.mjs" record-review | record-approval | package | render-snapshot ...
```

`node mv.mjs help` lists every option. Runs live at
`<root>/.specs/marketing-video/<project>/<run-id>/`. `preflight --install`
downloads about 300 MB once (npm packages and a headless Chrome); it costs
nothing but tell the user before the first install.

## Capability status

Report this honestly; never claim an unbuilt path works.

| Capability | Status |
|---|---|
| Screenshot → motion video, captions (incl. Arabic RTL), MP4, editable snapshot | built and tested locally |
| Manual recordings as shots (trim, mute/keep audio) | built; used for a real product reel (StoreCraft) |
| Voice from a take the user generates by hand on a provider's website (e.g. ElevenLabs), cut into lines | built and used |
| Draft voice via macOS `say` | built; MSA only and robotic — not for anything the user hears |
| Egyptian Arabic voice | via a hand-generated take; automated generation needs a paid plan with commercial rights |
| Natural-language revision with shot-level regression evidence | built; tested once on the generic fixture (sampled frames, audio not compared) |
| Automated browser capture (Playwright) | not built yet |
| Browser-operated provider (voice, generative video) | a first-class execution path beside local, free API and paid API; not built for any provider yet. Each provider is authorized from its own recorded terms status (`permitted`, or `ambiguous` with a scoped user session approval), never by blanket rule — see production |
| Recording redaction | static masks (browser bars, account menus) built; moving masks not built |
| Background music that ducks under the voice, with a measured voice/music margin | built; the track itself needs rights evidence (user-supplied, provider-generated, or locally generated placeholder) |
| Crossfades, whole-screen-then-zoom camera, cropping recordings to the app window | built |

## Governance

Planning and review follow ship-ticket's cross-model method
([cross-model](../ship-ticket/references/cross-model.md) — if absent: the host
drafts, the opposite-model counterpart critiques read-only within a bounded
budget, and disagreements are recorded rather than forced to consensus),
adapted here:

| Concern | In this skill |
|---|---|
| Counterpart | Claude host → Codex; Codex host → Claude |
| PLAN | at most three counterpart calls; unresolved points go to the user with both positions |
| REVIEW | **required**, not optional: a fresh Claude reviewer and Codex both inspect frames and QA; a missing reviewer leaves the output a draft |
| Repair | one consolidated repair batch per review, then re-verify and one targeted confirmation |
| Continuation | keep going through safe zero-cost steps; stop only for the hard stops below |

## Hard stops

Stop and ask exactly one question when: a login, MFA or CAPTCHA awaits the
user; an action would consume credits or money without a matching approval;
usage rights are uncertain for something the user wants final; a factual claim
lacks evidence; sensitive data cannot be sanitized; an action is destructive
or touches live customer data; a required reviewer is unavailable; or the
final preview needs the user's approval. Everything else — linting, local
renders, inspection, documented iteration — continues without asking.
