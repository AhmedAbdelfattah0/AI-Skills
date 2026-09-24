# Deterministic Planted Defects

| Planted defect | Expected rule ID | Expected JSON evidence |
|---|---|---|
| LOCKED `#5b8def` body text on white is below 4.5:1 | A11Y-01, ID-02 | `contrast.json` has a failing `text` row and a `locked-brand` row with `proposal` |
| Icon-only button has no accessible name | A11Y-14 | `axe.json` contains the `button-name` violation |
| Email input uses only a placeholder and has no autocomplete token | A11Y-16, FORM-01, A11Y-27 | `forms.json` has `#email` with `placeholderOnly: true`, `nameSource: "placeholder"`, and `autocomplete: null` |
| One target is 20×20 and another is 36×36 | A11Y-09 | `targets.json` records `below24` for the first and `below44` for both |
| Spacing values include 13px, 22px, and 37px | VIS-02 | `tokens.json.offScale.spacing` contains all three values |
| The page renders nine distinct font sizes | VIS-03 | `tokens.json.rendered.fontSize` contains at least nine authored sizes |
| One button removes its focus outline without replacement | A11Y-06 | `focus.json` has a step for `#no-focus` with `visible: false` |
| A sticky header covers a fixed keyboard-focusable control | A11Y-07 | `focus.json` records `obscured: true` for the covered control |
| A fixed-width 400px element overflows at 320px | A11Y-19 | `reflow.json` has `horizontalScroll: true` |
| A 600ms linear transition has no reduced-motion override | MOT-02, MOT-03, MOT-04 | `motion.json` includes `600`, `transform`, and `reducedMotionRespected: false` |
| Dark colors change under `prefers-color-scheme` | MOD-01 | `theme.json` reports `dark: "detected"` with method `media` |
