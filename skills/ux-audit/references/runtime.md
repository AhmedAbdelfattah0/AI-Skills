# RUNTIME — prepare and execute an evidence capture

Use this reference to configure the bounded browser capture against a user-supplied running application.

The skill never starts the app and never modifies application code. Ask for a
running base URL. Use only user-supplied routes; do not crawl links or add routes
without asking.

## Preflight and write boundary

Before writing, record `git status --porcelain` at the target root when it is a
Git checkout. The only permitted target writes are:

- a root `DESIGN.md`, only after the identity interview and explicit consent;
- `.specs/ux-audit/<run-id>/**`.

After the capture and report, run the same status command and compare it with
the baseline. Any new or changed path outside the allowlist is an integrity
failure: stop, report the path, and do not clean up or overwrite user work.

Create `<run-id>` as UTC `YYYYMMDD-HHMMSS-xxxx`, where `xxxx` is four hex
characters. Sanitize route IDs and scenario names to `[a-z0-9-]` before using
them in filenames. Resolve every destination beneath the run directory.

## config.json

Write `.specs/ux-audit/<run-id>/config.json` before running the tool. JSON has no
comments; omit optional fields when unused.

```json
{
  "baseUrl": "http://localhost:4200",
  "routes": [{"id":"home","path":"/","readySelector":"main","scenario":"default"}],
  "scenarios": {
    "empty-cart": {
      "route": "home",
      "state": "empty",
      "steps": [{"action":"route-mock","url":"**/cart","status":200,"body":{"items":[]}}]
    }
  },
  "interactions": [
    {"route":"home","selector":"button.add","action":"click","safe":true,"expect":"any-visible-change"}
  ],
  "storageState": "/absolute/path/outside/run-artifacts/auth.json",
  "theme": {
    "mode":"auto",
    "toggleSelector":null,
    "attribute":{"selector":"html","name":"data-theme","dark":"dark","light":"light"}
  },
  "rtl": {"mode":"auto","url":null,"attribute":null},
  "viewports": [320,390,768,1024,1440,1920],
  "lockedColors": ["#5b8def"],
  "sourceGlobs": ["src/**/*.{css,scss,sass,less}"],
  "projectRoot": "/absolute/path/to/target"
}
```

Allowed route-step actions are `click`, `fill`, `press`, `wait`, and
`route-mock`. Scenario states are `empty`, `loading`, `error`, `success`,
`disabled`, or `other`. Redact query strings in recorded URLs. Store only the
`storageState` path: never copy or log its contents, and never use it when the
resolved base URL changes origin.

## Readiness and states

For each route, readiness is either `DOMContentLoaded` plus
`document.fonts.ready`, bounded DOM quiet, and two animation frames, or a
configured `readySelector`. Give every wait a ceiling and record a timeout as
degraded. Never wait on unbounded `networkidle`; analytics, sockets, and polling
can keep it open forever.

Capture default and configured state scenarios. Reach empty, loading, error,
success, and disabled states through safe steps or route mocking. Never submit,
delete, pay, or mutate real data to create evidence. Without a configured and
successful scenario, the corresponding `STATE-*` checks are gaps rather than
passes.

## Theme and direction

Detect dark mode in this order:

1. configured `theme` mode and selectors or attributes;
2. the application's reachable theme toggle;
3. `prefers-color-scheme`, accepted only when switching it changes a computed
   style vector across representative background, text, border, and control
   elements.

Record `detected`, `absent`, or `ambiguous` in `theme.json`. Ambiguous is a
coverage gap. Light is always captured; dark is captured only when detected.

Detect RTL from the document `dir` attribute, computed `direction`, or a
configured RTL URL or attribute. If DESIGN.md says RTL or both but no RTL view
is reachable, write `rtl: "not-reachable"` and record an `I18N-*` gap. Do not
claim absence merely because the default route is LTR.

## Safe interactions

The `PERF-07` probe runs only entries with `safe: true`. Validate that the
action cannot submit a form, delete or mutate durable data, initiate payment,
or cross the configured origin. Refuse unsafe entries even if marked safe.
Unconfigured safe interactions produce a `PERF-07` coverage gap. Record first
visible feedback latency or `null` with status; do not reinterpret it as field
INP.

## Dependencies and execution

Node 20 or newer is required because the pinned Playwright 1.63 dependency
requires it. Bootstrap reuses a compatible target installation when available;
otherwise it runs the scripts lockfile's `npm ci` in a version-keyed user cache,
never inside the target. Browser installation is opt-in:

```text
node <skill-root>/scripts/run.mjs --config <target>/.specs/ux-audit/<run-id>/config.json [--only capture,axe,...] [--install-browsers]
```

Only `--install-browsers` authorizes bootstrap to run `playwright install
chromium`. If dependency or browser resolution fails offline, keep all
available lanes running, mark the affected lanes degraded in `lanes.json`, and
report the exact same command with `--install-browsers` as remediation for a
networked environment.

Exit codes are `0` for all requested lanes completed, `3` for a degraded run,
and `2` for invalid usage or configuration. One lane failing never cancels the
others. Treat every expected JSON file as evidence only when its lane status is
`ok`; `degraded` and `skipped` require a reason and remediation and leave the
corresponding rules as gaps.

Screenshots use widths 320, 390, 768, 1024, 1440, and 1920 with heights 844,
844, 1024, 768, 900, and 1080 respectively. Capture full-page light images,
plus dark when detected, with animations suppressed. The separate
reduced-motion probe supplies `MOT-04` evidence.
