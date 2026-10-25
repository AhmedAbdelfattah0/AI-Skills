# Quality gates

Load during PRODUCE (gates) and PROVE (verify).

## Gates — `check`, also run by `render` and `verify`

| Gate | Severity | Fires when |
|---|---|---|
| MV-SCHEMA | block | bad frame rate/size, no shots, duplicate IDs, bad durations, highlight outside the asset |
| MV-REF | block | a shot, text or voice line references something missing or of the wrong kind |
| MV-KIND | block | an asset kind is unknown, does not fit its capture method, or a generated asset names no provider |
| MV-RESTRICTED | block | an asset file resolves into `restricted/` or outside the run (symlinks resolved) |
| MV-ASSET-HASH | block | an asset's bytes differ from the manifest |
| MV-PRIV | block | an asset is not `clean`/`redacted`, or its attestation was for other bytes |
| MV-TRUTH-INTERACTION | block | a shot declares a synthetic cursor, click, tap, typing or interaction |
| MV-TRUTH-CLASS | block | a text or voice line has no valid class |
| MV-CLAIM | block | a factual line has no claim, or its claim is unverified; a verified claim's evidence lacks an excerpt, names a missing asset, has the wrong hash or an out-of-bounds region, or is an unsourced document or user statement |
| MV-VOICE-TEXT | block | the words a voice asset actually speaks differ from the timeline line |
| MV-CAPTIONS | block | a voice line's words are not on screen (caption or overlay with the same words) for at least 90% of the time it is spoken |
| MV-FRAMING | block | from the first caption, voice or highlight frame of its shot, a highlighted target is not wholly inside the safe area clear of the caption and label bands |
| MV-DISCLOSURE | block | the disclosure is empty, over 60 characters, or not one of `project.json` `disclosureLabels` |
| MV-PROHIBITED | block | a line or the disclosure contains a prohibited claim |
| MV-CONCEPT | block | a conceptual line sits on a recording, screenshot or logo |
| MV-TIMING | block | a caption is outside its shot, under 0.8 s, or overlaps another caption in the same language; a voice line overruns its shot |
| MV-COST | block | spend without an active, unexpired user spend approval for that provider and unit; charged plus reserved above the cap; an approval awaiting reconciliation |
| MV-RIGHTS | draft | an asset or tool lacks verified commercial use |
| MV-PLACEHOLDER | draft | an asset is marked as a stand-in (`ingest --placeholder`), e.g. placeholder music |

## Verify — `verify --rev N`

Binds the report to the MP4's and timeline's SHA-256 and checks: codec,
dimensions, frame rate, frame count (±1), duration, full decode with no
errors, audio presence matching the declared policy, clipping, a non-silent
window for every voice line, no silent stretch over 2 s mid-video (3 s at the end) in a voiced video, measured text boxes inside the safe zone without
overflow for every rendered string — text items, the disclosure and AI-generated labels — at its first, middle and last frame (a missing or malformed measurement fails), evidence frame
extraction, and the gates on the snapshot. It writes `qa.json`, `qa.md` and
`frames/` — every shot's first, middle and last frame, two frames either side
of every cut, and each text item once visible.

`verify` failing is a defect to fix, not a report to forward.

## What automation cannot judge

Listed in every QA report and left to the reviewers and the user: hook,
pacing and clarity; audio sync, voice quality and dialect; motion between
sampled frames; caption legibility on a phone; semantic truth of each factual
line and of text inside footage; privacy beyond the inspected frames.

## Negative scenarios to keep demonstrable

| Scenario | Expected |
|---|---|
| unsupported claim | MV-CLAIM blocks, or the line is rewritten to the evidence, or labeled conceptual on a card |
| sensitive data | MV-PRIV blocks until sanitized and re-attested, or the asset is replaced |
| unavailable or unapproved paid provider | local fallback; output labeled draft; the limitation reported |
| oversized caption | QA-LAYOUT fails |
