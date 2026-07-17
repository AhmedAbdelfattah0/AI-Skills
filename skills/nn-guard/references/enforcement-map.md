# Enforcement Map — which rule, which layer, why

Layer 1 = code-quality skill (prompt) · Layer 2 = PostToolUse hook · Layer 3 = CI STRICT.
Every rule lives at layer 1; this map records which also have deterministic coverage.

## BLOCK at layer 2 + 3 (signature near-unambiguous)

| Rule | Signature | Why blocking is safe |
|---|---|---|
| BE-SEC-10 | `REJECT_UNAUTHORIZED=0`, `InsecureSkipVerify: true`, `verify=False` | No legitimate production use; near-zero false positives |
| NG-SEC-02 | `bypassSecurityTrust` | The API name is the finding; sanitize() is the alternative |
| BE-WHK-01 | `==`/`!=` against `signature`/`sig` | Constant-time verify is always available |
| BE-SEC-05 | SQL keyword inside a template/f-string with interpolation, or string + `req.*` | Parameterization always works; interpolated SQL is the injection |

## WARN at layer 2, BLOCK at layer 3 (heuristic, or legitimate mid-development)

| Rule | Signature | Why not edit-time blocking |
|---|---|---|
| TEST (focus leak) | `test.only(`, `it.only(`, `describe.only(`, `fit(`, `fdescribe(` | Legitimate while debugging locally; committing one silently skips the rest of the suite — that boundary IS the CI gate. From the `test-quality` skill. **Candidate — enable only after the change protocol (must FAIL on a known-bad sample first).** |
| NG-CORE-01 | `: any`, `<any>`, `as any` | Matches comments/strings; migration code exists |
| NG-CORE-03 / BE-Q-02 | `console.log(` | Normal while debugging; the rule forbids *committing* it — that boundary IS the CI gate |
| BE-SEC-07 | `catch () {}` | Multiline empty catches evade grep anyway; treat as smoke signal |
| NG-UI-02 | hex/rgb/hsl in scss | Token files legitimately contain raw color — exclude-list them, warn everywhere else |
| BE-RT-03 | `key/secret/password = "<16+ chars>"` | Test fixtures and examples collide; a block here breeds resentment |
| NG-SEC-04 | inline `on*=` in html | Angular templates use `(click)`; raw html snippets in docs collide |

## Layer 1 only (no honest mechanical signature — do not fake a check)

BE-SEC-01/02/03/04/08/09 · BE-AUTH-01…09 · BE-VAL-01…05 · BE-TEN-01…05 · BE-RT-02/04 ·
BE-HDR-01…06 · BE-WHK-02…08 · BE-AUD-01…04 · NG-SEC-01/03/05/06 · NG-CORE-02 ·
all [ARCH]/[D].

These need semantics grep can't see (is the tenant from the token? is the audit table
REVOKEd?). Their enforcement is the skill + the reviewer pass + tests. If self-healing
finds one repeatedly violated AND a reliable signature emerges, promote it here — but a
check that fires on good code is worse than no check.

## Change protocol

Guard weakening (removing a check, demoting BLOCK→WARN, broadening an exclude) =
[NN]-tier change: proposal + explicit human approval + ledger entry. Guard tightening =
free, but the self-test must pass and the new check must FAIL on a known-bad sample
before it ships.
