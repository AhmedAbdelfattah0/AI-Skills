# Independent review and revision

Load during REVIEW and REVISE.

## Review of actual output

Neither reviewer receives the builder's summary of quality. Each gets:
the evidence frames (`reports/r<N>/frames/*.png`), `qa.json`, the snapshot
timeline and claims, the source asset images, and the MP4 path. Capabilities
are fixed and stated in the brief: both read still images; neither can play
video or listen, so motion between samples, audio sync and voice quality stay
with the user.

| Reviewer | Carrier |
|---|---|
| Claude | a fresh subagent with no build context, reading the PNGs |
| Codex | `codex exec -s read-only -c model_reasoning_effort=high -i <frame.png> …` with the brief on stdin and an external timeout; the relay used for planning does not attach images |

Ask each for at most twelve findings — severity, frame/shot, what is wrong,
consequence, fix — covering truthfulness against the claims and source
images, fabricated or implied interactions, privacy, caption legibility and
Arabic shaping, framing of the control being discussed, brand consistency,
and story. Record each with `record-review --reviewer claude|codex --verdict
PASS|CHANGES_REQUESTED --file <their text>`; the record is bound to the MP4
and timeline hashes QA verified, and only a PASS on exactly the packaged MP4
counts toward final.

Reconcile once: accept with a fix or reject with evidence. Apply all accepted
fixes in one batch as a new revision, re-run `verify`, and ask the reviewer
that raised each finding to confirm only those findings on the new frames.
Unresolved disagreement goes to the user with both positions.

## Natural-language revision

1. Map the note to shot IDs and fields: "shorten the intro" → hook shot
   `durationFrames` and its text/voice; "zoom on Add Product" → that shot's
   `camera.to` and `highlight`; "slower voice" → a new `voice` take at a
   lower rate, then re-size the affected shots.
2. Edit `timeline.json` in place, set `parentRevision` to the current
   revision and increment `revision`. Do not touch other shots.
3. `check`, `render`, `verify`.
4. `compare --from <old> --to <new>`. Unaffected shots must be `preserved`.
   A change to any global input (composition, brand, safe zone, render
   settings, disclosure) makes every shot affected — say so instead of
   claiming preservation.
5. Write `reports/revision-r<new>.md`: the note verbatim, affected shots and
   why, what changed, the compare result, and what still needs the user's
   eyes (anything audio or motion).

Compare evidence is sampled: five shot-local frames per shot, mean absolute
difference ≤ 1.0 and 99th-percentile difference ≤ 8 on a 0–255 scale. Report
it as sampled regression evidence, never as proof every pixel is unchanged.
Earlier previews are kept so the user can watch both.
