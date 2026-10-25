# Acquisition

Load during ACQUIRE. Goal: every visual and audio source in `assets/` with
provenance, rights and a privacy status bound to its bytes.

## Sources

| Source | How | Notes |
|---|---|---|
| Manual recording (MP4/MOV) | `ingest --kind recording --method manual`, then `sanitize --crop` to the app window | ask whether its audio is wanted (`--audio keep`); default mute. For vertical video, ask for a capture from a narrower browser window (about 1280 px wide or less) |
| Music | `ingest --kind music --method provided\|generated` | rights evidence required |
| Screenshot (PNG/JPG/WebP) | `ingest --kind screenshot --method manual\|screenshot` | animated by camera moves only |
| Logo, product imagery | `ingest --kind logo --method provided` | rights from the user |
| Generated scene | `ingest --kind generated --method generated` with cost and approval | labeled on screen; never product UI |
| Voice | `voice` (see production), or a take made by hand on a provider's website: `ingest --kind voice --method provided --provider … --text … [--from --to]` | record the exact words; add `--text-verified-by user` once the user has listened |
| Brief only | no ingest | ask for captures or an approved capture source; never invent UI |

Choose the minimum path that shows the claim. Ask for a recording when the
claim is about an interaction; a screenshot cannot show one.

`--rights yes` only when the user or the source's license says so; otherwise
leave `unknown` and the delivery stays a draft.

## Privacy

1. Inspect every visual asset before attesting. For a screenshot, view the
   whole image. For a recording, extract frames (at least one per second and
   at every scene change) with the renderer's ffmpeg and view them.
2. Look for: real customer names, emails, phone numbers, addresses, order
   numbers, credentials, tokens, API keys, internal URLs, browser chrome,
   notifications, other tabs, personal avatars.
3. Clean → `attest --status clean --method <full-frame-review|sampled-frames> --frames <n>`.
4. Sensitive screenshot → `sanitize --boxes '[…]'` (opaque masks baked into a
   derivative from the restricted original), view the result, then
   `attest --status redacted`.
5. Sensitive recording → masks over moving content are not built; ask the
   user for a re-capture with synthetic data or drop the clip. The asset stays
   `contains-sensitive` and blocks render.

Record honestly what was inspected; the attestation says sampled review is
not a guarantee.

## Automated capture

Not built in this version. Until it is, offer a manual capture or a
screenshot of an approved local/staging page with synthetic data. When it is
built, it must: bind authorization to the scenario hash, environment, allowed
origins and allowed actions; abort any request to an origin outside the
allowlist (redirects and popups included); accept `file:` only from an
approved fixture directory; authenticate before the recording context starts
so login never appears on video; and support only seeded synthetic data
without explicit permission for anything else.

## Human-assisted login

When a source or provider needs a login, MFA or CAPTCHA: open the page, tell
the user what to complete, and wait for their confirmation. Never ask for a
password, never script around a challenge, never store cookies or session
files under `.specs/`. Resume only in the session the user authorized.
