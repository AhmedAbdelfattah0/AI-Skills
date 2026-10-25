# Creative planning

Load during PLAN. Output: verified `claims.json`, a `timeline.json`
revision 1, a reconciled counterpart critique, and user decisions for any
material creative or cost choice.

## Story

For a 15–30 s vertical Reel: hook (≤3 s, one idea), 2–4 proof shots each
showing one claim on real UI, CTA. Tutorials and demos follow the real task
order. Start every proof shot wide enough to orient, then move toward the
control the line talks about. Keep the target control in frame for the whole
move, not only at the end; the framing gate enforces this for highlights.
Open on real UI within the first second where possible; a plain title card
is a weak hook. Give the CTA the product name and where to go.

## Claims first

1. List every assertion the script will make.
2. For each, find evidence the user supplied or a capture shows; write it in
   `claims.json` with the exact assertion and what the evidence shows.
3. An assertion the evidence does not show is cut, rewritten to what is shown,
   or — only on a card, never on product footage — marked `conceptual` and
   labeled. Speed, ease, ranking, price and testimonial claims need explicit
   evidence or a user-provided source.
4. Check `project.json` `prohibitedClaims`.

## Words

Every caption, overlay and voice line gets a `class`. Every voice line needs
a caption or overlay in its shot with the same words (most Reels are watched
muted); don't repeat the same words as both overlay and caption. A `neutral`
hook question must not set up a benefit the next lines can't prove ("lots of
products, can't organize them?" implies an organizing feature). Keep a caption on
screen at least 0.8 s and within its shot. For Arabic, set `lang: "ar"` and
`dir: "rtl"`; avoid mixing scripts inside one line where possible.

## Timing

Generate voice lines first (`voice`), read each measured duration, then size
the shot: `durationFrames ≥ startFrame + ceil(duration × fps)` plus breathing
room. The gates block a line longer than its shot.

## Counterpart critique

Send the brief, claims, timeline and the source images' paths to the
opposite-model counterpart read-only (budget and method in SKILL.md
Governance). Ask it to challenge truthfulness, story, pacing, accessibility,
provider choice and cost. Reconcile with evidence; record unresolved points
for the user rather than forcing agreement.

## What needs the user

Material creative direction the brief leaves open (tone, which feature
leads), any spend, unknown rights the user wants final, and voice choices
with quality or licensing trade-offs. Routine shot sizing does not.
