# AIS-HARNESS-4 — closing record

Date: 2026-11-10. Ticket: risk-adaptive security planning and verification for ship-ticket
(`.specs/plans/AIS-HARNESS-4.md`). This record lists what was delivered, the proof for each
acceptance criterion, and the final state of every item that was open. Nothing is left
undecided: each item is fixed, intended and documented, or handed over with the one input
it needs.

## What was delivered

| Wave | Pull request | Merge commit | What |
|---|---|---|---|
| A | #39 | `c84e9cf` | The control catalog `skills/vapt/controls.json` and its tests |
| C part 1 | #40 | `484ef3c` | 35 fixture scenarios with labels and baselines |
| B | #44 | `111c06f` | Plan section 3a, the selector, the catalog-bound gate, reassessment |
| B follow-up | #46 | `5a3793c` | Base commit re-resolved after the proof; a test path fix |
| C part 2 | #47 | `0eb0e49` | The effectiveness measurement and report; fixtures version 6 |
| Closing hardening | #48 | `77f5c44` | The selector, gate and engine leftovers |
| Closing record | this pull request | — | This file, two tests, the `CLOSED` event |

## What the measurement found

From `skills/vapt/fixtures/effectiveness/REPORT.md`, under the rule fixed before the run:
**"On this corpus the catalog did not show useful selection."** On the development cases
(retrospective, in-sample, development data) 22 to 25 of the 25 controls are selected per
case, and with a group's own controls removed, none of its findings is still caught by
another specific control that both judges accept. Of 24 public advisories, 10 needed an always-on control and 14 had no
control both judges accept; none needed a specific control. No claim of security improvement
or generalization is made. The selector follows the catalog (231 of 231 on the fixtures).

## Acceptance criteria

| # | Criterion | State | Proof |
|---|---|---|---|
| AC1 | The catalog validates and matches the vapt table; vendored `security-audit` unchanged | met | `skills/vapt/controls.test.mjs`: "catalog and SKILL.md tables agree on ids and tiers", "static_mirror agrees with the SKILL.md mapping table in both directions", "attack text equals the SKILL.md row exactly after normalisation". `git log a8ef559..HEAD -- skills/security-audit` is empty |
| AC2 | `select` meets the expected sets on all fixtures; unknown facts keep controls; no keyword-only rule | met | `security-plan.test.mjs`: "fixture scoring: catalog-faithful baseline, per-scenario must_select, and the scorer bites", "an unknown fact keeps its controls selected and is listed", "AC2 a keyword match alone creates a signal and never selects a control" |
| AC3 | Grandfathered runs byte-identical; no new artifacts when reassess finds no signals; suites green; validator passes | met | `run-engine-units.test.mjs`: "golden: a v1 DAG without unit fields yields the pre-Wave-2a state, events and outputs". `run-engine-security.test.mjs`: "[S12] C3 a legacy (grandfathered) run carries no security key, event or output". `security-plan.test.mjs`: "AC3 a re-check that finds no change writes nothing to disk", which covers the standalone helper. The engine's `gate reassess` adds no file either: it records the reassessment in the existing state file and writes one `SECURITY_REASSESSED` event to the existing engine log and to the plan file's RUN-STATE; no test snapshots the files at engine level. CI green on #48 |
| AC4 | `gate ship-ready` refuses a selected control without an accepted RED and a passing named spec; a skip, a placeholder or a stale candidate fails; a waiver forged while work is live is refused | met | `gate-security.test.mjs`: "[S4] C7 spec-status matrix ... only pass proves", "[S6] C10 gateShipReady: two pairs, one proven -> control_unproven names only the other". `run-engine-security.test.mjs`: "[S7] [S6] C8/C10 a skipped pair spec ...", "[S11] C11 a pair spec whose bytes changed since RED never proves the pair", "[S19] a pair spec suppressed at import ... never proves its pair", "[S15] C6 each freshness part alone makes the reassessment stale", "[S10] C5 SECURITY_WAIVER appended while a proof runs is untrusted: waiver_unauthorized (judgment); a distinct owner re-append is honoured", "[S10] C5 a worker that appends SECURITY_WAIVER or SECURITY_ADDENDUM is an ownership violation and never honoured" |
| AC5 | `reassess` flags an out-of-plan path, a new dependency, an auth or migration change, a new route, a new mail, payment or stock call; `REAPPROVAL` never continues; `ADD_CONTROLS` is add-only across resume | met | `security-plan.test.mjs`: "reassessSignals: mechanical path and added-line patterns; a benign path gives none", "reassess: an out-of-contract path forces REAPPROVAL; the same path inside the contract does not", "reassess: a new in-contract surface is ADD_CONTROLS with an addendum; that addendum makes it UNCHANGED (add-only across resume)". `run-engine-security.test.mjs`: "[S16] reassess: ... an out-of-contract path is REAPPROVAL and stops drive" |
| AC6 | Review refuses a primary that misses a control row; the second opinion returns findings only | met; the second half is a documented rule, not a test | `run-engine-security.test.mjs`: "[S14] review: a missing pair row, an unwaived NOT_APPLICABLE row and NOT_TRIGGERED are refused; a waiver admits NOT_APPLICABLE". `skills/ship-ticket/references/security-risk.md` section 9: the second opinion "receives the security plan and returns findings only" |
| AC7 | A report with pre-registered metrics, per-family hold-out results and named limits | met as amended by the approved Wave C part 2 plan | `skills/vapt/fixtures/effectiveness/REPORT.md`, `prereg.json`; hashes posted on issue #45 before scoring. In place of a hold-out, the per-family result is an ablation (R3: a family's own controls are removed), which `prereg.json` names "dependence on family-derived controls" and states is not a generalization result |
| AC8 | The small-fix path adds at most 1 plan line and no extra agent; helper overhead measured | met as amended by the owner on 2026-11-10 | An empty selection prints one prose line plus the pairs line and the machine block, which bind the plan to the DAG and cannot be dropped (`security-plan.test.mjs`: "an empty selection renders the compact form ..."). No agent is involved: the planner runs the helper. Timing below |

### Helper timing (AC8)

One measurement on 2026-11-10: Apple M4 Pro, Node 22.23.1, each command started as a fresh
process 20 times after 2 warm-up runs. The machine was not idle (load average 3.6), so the
numbers lean high.

| Command | Median | 95th percentile |
|---|---|---|
| `select`, 20 controls selected | 26.7 ms | 28.2 ms |
| `select`, nothing selected | 26.2 ms | 28.2 ms |
| `reassess`, unchanged | 27.5 ms | 29.8 ms |

## Every open item and its final state

**Fixed in #48** (each code fix with a failing test first; 12 new mutants, 40 in total, all caught):
- The standalone `reassess` took a re-pathed approved boundary id as given. It now unites
  the approved surfaces itself and refuses a redefined id.
- Backslashes in surface, changed-file, spec and test-file paths were silently converted.
  They are refused, or count for nothing.
- A test command with `--import=`, `--require=`, `--loader=` or another reporter could let
  one file's results count for another. Only listed options count now.
- Nested test names containing `#` or `\` never matched their spec.
- After the local proof, `gate ship-ready` reused the security context built before it.
  It rebuilds it and repeats its checks.
- `init` accepted a plan whose approved surface lies outside every node's writes, or whose
  approved block the helper refuses. Both are refused at `init`.
- Engine tests for the surface rule covered one of three surface kinds. They cover all three.
- A local copy of `unknownish`, a stale test title, a comment true for Node 20 and later only,
  a missing UNC row, workflow permissions.

**Fixed in #46 and #47:** the cached base commit after the proof; a test path; the five
points of CodeRabbit's review of #47; the in-sample labels in the report.

**Intended, and documented where stated:**
- A classification can close a route, auth or migration signal on a path that is exactly an
  approved surface. Kept by the owner on 2026-11-10, pinned by tests, stated in
  `security-risk.md` section 7.
- Reassessment runs when the orchestrator calls `gate reassess`; a freshness check refuses
  review and ship-ready otherwise (`security-risk.md` sections 7 and 8).
- Under TAP a pair spec is proven only by a command that runs exactly that one spec file
  (`security-risk.md` section 7).
- Input surfaces to `gate reassess` are not stored and are supplied again on each call
  (`security-risk.md` section 7).
- A surface kind that does not select the whole control class leaves the signal open
  (`security-risk.md` section 7).
- A surface path is a file; a directory path matches no signal (`security-risk.md` section 3).
- A backdated START passes the policy start date, and a catalog change makes running
  policy-2 runs stale (`.specs/plans/AIS-HARNESS-4-wave-b.md` open risks; `security-risk.md`
  section 8).
- The sealed fixture set has no ADD_CONTROLS scenario; that outcome is covered by tests in
  `security-plan.test.mjs` and `run-engine-security.test.mjs`.
- The parent plan's front matter lists only the Wave A branch. It sits inside that plan's
  approved digest and is not edited; the table above and the `CLOSED` event list every wave.
- Markdown table warnings in `.specs/plans/AIS-HARNESS-4-wave-c2.md`: the file is inside its
  approved digest.

**Recorded limits, not changeable from here:**
- Windows: the path fixes are exercised by canned rows on every platform and by the CI
  matrix; they were never run by hand on a Windows machine. The `fileURLToPath` fix of #46
  sits in tests that skip on Windows.
- A preload set through `NODE_OPTIONS` in the engine's own environment is outside the
  attribution check; a worker cannot set that environment.
- In the measurement, the agents' blindness is by instruction only, and the development
  inputs are local only (`REPORT.md`, Limits).
- Timing telemetry was not recorded for Wave B or for the closing pass.

**Handed over, each with the input that settles it:**
- The engine test suite fails when several copies run at once on one machine. It predates
  this ticket; CI is not affected. Evidence and failing test names are in issue #49.
- On the development cases (retrospective, in-sample, development data) the selector picked
  22 to 25 of the 25 controls per case. Those inputs were whole cited files plus the messages
  of up to 8 commits, which is broader than one real ticket. On the public advisories the
  median was 17.5 of 25. Whether tighter inputs select fewer was not measured, by the owner's
  decision. This is the first question for the next enhancement of selection.
- The catalog has no control both judges accept for 14 public advisory cases (parser and
  regex denial of service, a symlink escape, personal data in logs, output encoding and
  others) or for development finding F21. Whether the catalog should cover them is a scope
  decision for the next enhancement. The catalog was not changed, because a change makes
  the measurement stale.
- The eight business-logic controls have not been tested on another product. No old
  reports exist. The way to settle it: run the `security-audit` skill on another product
  and score its findings with the tools in `skills/vapt/fixtures/effectiveness/`.

## Housekeeping done

No merged branch of any wave remains, locally or on the remote. Before each deletion a check:
for #44, #46, #47 and #48, which were squash-merged, the branch's files were compared with
`main` at the merge commit and were identical. For #39 and #40 the branch head was the head
of the merged pull request. Temporary worktrees removed. Issue #45 (pre-registration hashes) closed
with a pointer to the report.
