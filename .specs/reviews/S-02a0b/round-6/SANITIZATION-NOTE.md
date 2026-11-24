# Sanitization note

On 2026-11-25, for privacy (owner decision), one absolute local path in
`mutate6.py` (the `REPO = ...` line) was replaced by the `<HOME>` placeholder.

- The sha256 recorded in `mutation-round6-final.log`, `mutation-round7-area.log`,
  `mutation-round7-confirm.log`, `mutation-round7-minor.log` and
  `mutation-round8-area.log` (line 7 of each) refers to the pre-sanitization bytes.
  - Old sha256: `d5d18851d7faaa24fa41e178973314aa848bd51c1027fcc21d1ad45a8d62e8c5`
  - New sha256: `da021ed26ca13816e828fd557dca8ee724cd7d77e8102f953132ec7770854d5d`
- Cause: the path placeholder only; nothing else in the file changed. The original
  bytes are in git history at commit `bb6c054`.
- The script is not runnable as-is: `REPO` pointed at a separate local checkout.
