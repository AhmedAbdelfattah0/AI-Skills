# Contracts

Load during DISCOVER and whenever you write a run file by hand. All files are
JSON with `schemaVersion: 1` unless noted. These six logical contracts are
the shared core later Studio capabilities reuse; keep them distinguishable.

## Layout

```text
<root>/.specs/marketing-video/<project>/
  project.json                 ProjectConfig (one per product)
  acceptance.json              Phase acceptance ledger (optional, per project)
  <run-id>/
    brief.json                 CreativeBrief
    asset-manifest.json        AssetManifest
    claims.json                ClaimEvidenceMap
    timeline.json              ProductionPlan (shots + text + voice in one file)
    approvals.json             user decisions on spend and on the final video
    decisions.jsonl            append-only decision log (provider choices, renders, packages)
    restricted/                originals; self-ignoring .gitignore; never packaged
    assets/                    sanitized derivatives used by the timeline
    project/r<N>/              self-contained snapshot of revision N: composition, config, claims, assets
    previews/r<N>.mp4          rendered revisions, never overwritten by a new revision
    reports/r<N>/              qa.json, qa.md, layout.json, frames/, review-<reviewer>.json
    reports/compare-r<A>-r<B>.json
    exports/r<N>/              delivery package
```

ReviewReport = `reports/r<N>/qa.json` + the `review-<reviewer>.json` records + compare reports.

## project.json — ProjectConfig

`init` writes a template. Fields: `id`, `name`, `brand` (`colors.primary`,
`colors.ink`, `colors.accent`, `fontFamily`, `logoAssetId`), `languages`,
`audience`, `tone`, `prohibitedClaims` (case-insensitive substrings that block
any text or voice line), `channels`, `exportPresets.<name>` (`width`,
`height`, `fps`, `safeZone` in pixels from each edge), `execution` (the
provider policy below), `providers`, `disclosureLabels` (the only texts a timeline disclosure may use — it is never free text), `toolRights.<tool>` (`commercialUse:
yes|no|unknown`, `license`, `source`), `captureOrigins`.

```json
"execution": {
  "allowed": ["local", "browser", "free_api", "paid_api"],
  "optimize": ["quality_threshold", "incremental_cost", "simplicity", "reliability"],
  "allowHumanLogin": true, "allowHumanCaptcha": true,
  "approvalRequiredFor": ["paid_api", "credit_spend", "purchase", "publish"],
  "maxAutomaticRetries": 2
}
```

`toolRights.remotion` starts `unknown`: Remotion is free for individuals and
companies of up to three people and needs a company license otherwise. Ask the
user which applies before calling anything final.

## brief.json — CreativeBrief

`objective`, `contentType` (`reel|demo|tutorial`), `cta`, `audience`,
`durationSec`, `format` (preset name), `languages`, `budget` (`unit`, `cap`),
`sourceEvidence` (asset IDs or document references the story relies on).

## asset-manifest.json — AssetManifest

Each asset: `id`, `kind` (`screenshot|recording|logo|generated|voice`),
`file` (under `assets/`), `sha256`, `original` (`file` under `restricted/`,
`sha256`, `sourceName`), `captureMethod`
(`manual|automated|screenshot|provided|generated|tts`), `provenance` (`origin`,
timestamps, optional `url`, `environment`, `scenarioSha256`, `cost {amount,
unit}`, `approvalId`), `rights` (`commercialUse`, `source`, `license`),
`sensitivity` (`status: unreviewed|clean|redacted|contains-sensitive`,
`method`, `reviewedBy`, `reviewedSha256`, `framesReviewed`, `notes`,
`limitation`), `media` (`width`, `height`, `durationSec`, `hasAudio`),
`audioPolicy` (`keep|mute`), optional `sanitized`.

A privacy attestation is bound to bytes: when `reviewedSha256` differs from
`sha256`, the gates treat the asset as unreviewed.

## claims.json — ClaimEvidenceMap

```json
{ "id": "c-table", "text": "<the exact assertion>", "status": "verified|unverified",
  "verifiedBy": "agent|user", "evidence": [
    { "type": "asset|doc|user", "ref": "<asset id, URL or quote>", "sha256": "…",
      "region": { "x": 0, "y": 0, "w": 0, "h": 0 }, "time": 0, "excerpt": "what the evidence shows" } ] }
```

The claim text is the assertion the video makes, not a paraphrase of the
evidence. Evidence must show the assertion itself: a visible button proves
the button exists, not that a task takes one click.

## timeline.json — ProductionPlan

```json
{ "schemaVersion": 1, "revision": 1, "parentRevision": null, "preset": "reel",
  "fps": 30, "width": 1080, "height": 1920,
  "disclosure": { "text": "Demo fixture · synthetic data", "lang": "en", "position": "top|bottom" },
  "shots": [
    { "id": "s1", "assetId": null, "card": { "background": "brand|ink" }, "durationFrames": 90 },
    { "id": "s2", "assetId": "dashboard", "durationFrames": 120,
      "camera": { "from": { "scale": 1, "cx": 0.5, "cy": 0.3 }, "to": { "scale": 1.6, "cx": 0.85, "cy": 0.07 } },
      "highlight": { "x": 796, "y": 96, "w": 244, "h": 71 },
      "transitionIn": { "type": "fade", "frames": 8 }, "trimStartFrames": 0 } ],
  "text": [ { "id": "c2", "shotId": "s2", "kind": "caption|overlay", "lang": "ar", "dir": "rtl",
      "position": "top|center|bottom", "text": "…", "class": "factual", "claimId": "c-add",
      "startFrame": 6, "endFrame": 110 } ],
  "voice": [ { "id": "v2", "shotId": "s2", "assetId": "vo-add", "startFrame": 6,
      "class": "factual", "claimId": "c-add", "text": "…" } ] }
```

Frames are integers relative to their shot. `camera.cx/cy` is the normalized
point of the asset kept nearest the frame centre; `scale` 1 covers the frame.
Every rendered revision snapshot is digested; QA, reviews and approvals bind to that digest and the MP4 hash, so editing a snapshot invalidates them. `highlight` is in asset pixels and must stay wholly inside the safe area, clear of caption and label bands, from the first caption, voice line or highlight of its shot, whichever is earliest (MV-FRAMING); use `camera.moveFrames` to arrive before the line about the target plays. Shot IDs are stable across revisions — a
revision edits shots in place and increments `revision`, setting
`parentRevision`.

## approvals.json

```json
{ "id": "ap-1", "type": "spend|final-video", "decidedBy": "user",
  "quote": "<the user's words>", "provider": "…", "scope": "…",
  "unit": "USD|credits", "cap": 10, "reserved": 0, "consumed": 0,
  "retriesMax": 2, "expires": "…", "status": "active|needs-reconciliation|closed",
  "revision": 3, "mp4Sha256": "…" }
```

Write entries with `record-approval`, and only after the user says so; their
words go in `quote`. A `final-video` entry is bound to the MP4 hash watched.
Reviews are `reports/r<N>/review-<reviewer>.json`, written by `record-review`.

## acceptance.json — phase acceptance ledger

One row per acceptance scenario of the current phase: `id`, `title`,
`state` (`passed|open|blocked|optional-unavailable`), `evidence` (paths),
`note`. A scenario passes only with evidence from its real subject — a
generic fixture never passes a product-specific scenario.
