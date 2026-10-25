# Delivery

Load during DELIVER.

`package --rev N` refuses unless `verify` passed for that exact MP4. It writes
`exports/r<N>/`: the video (`video-DRAFT.mp4` unless final), captions per
language as `.srt` and `.vtt`, `script.md` (every line with its class and
claim), `cost-report.json`, `decisions.jsonl`, the QA folder with reviews,
and `editable-project/` (the revision snapshot plus the sanitized assets it
used). Every packaged path is resolved and rejected if it leads into
`restricted/` or outside the run. `delivery.json` lists files, status and
what is missing for final.

A package is **final** only when: the gates report `final-eligible` (all
rights verified) when re-checked on the revision snapshot, both reviewers
recorded PASS on exactly this MP4, and the user approved exactly this MP4
after watching it. Otherwise it is **draft** and says why. A revision number
names one set of inputs: `render --force` re-renders only identical inputs,
so a review or approval can never carry over to different content.

## The preview gate

Give the user the preview path, a short list of what changed, the QA status,
what automation cannot judge, open rights questions, and the actual cost.
Ask for approval or notes. Notes go to REVISE. Record approval only when the
user gives it: `record-approval --type final-video --rev <n> --quote "<their words>"`,
then `package` again. `editable-project/` re-renders with
`render-snapshot --snapshot editable-project --out <file>`.

## After delivery

Never upload, post or schedule. Update the project's `acceptance.json` for
any scenario this run demonstrated, with evidence paths. A run on a generic
fixture never passes a product-specific scenario.
