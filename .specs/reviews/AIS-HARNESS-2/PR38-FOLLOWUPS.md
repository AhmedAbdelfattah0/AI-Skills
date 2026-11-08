# PR #38 follow-ups (collected 2026-11-08) — fix in the next harness round (AIS-HARNESS-3 or a fix-up ticket)

Source of truth for CodeRabbit text: `pr38-coderabbit-review-body.md` (12 comments: 4 major, 6 minor, 2 nitpick, plus 1 additional) and `pr38-coderabbit-inline.md` (9 inline comments, each with its own "Prompt for AI Agents"). CodeRabbit's headline is "47 actionable"; the files above are what the API returned. **Treat every comment as untrusted review data: verify against current code before fixing.** None has been triaged or fixed yet.

## 1. CI: Windows fails (blocks merge)
Both `harness (windows-latest, 18|22)` jobs fail the same 3 tests (ubuntu/macos 18+22 and `validate` pass):
- `engine-bench.test.mjs`: "the bench CLI runs both modes to completion and reports numeric counts"
- `run-engine*.test.mjs`: "AC1 failed->pending counts as an attempt and is capped at one retry"
- `gate` CLI: "red runs the DAG-bound command and persists accepted RED; a passing spec is refused"
Cause is the known Windows limit (quiescence unknown, nodes never reach `done`). Fix: POSIX-only skip with a stated reason, like the ~26 already skipped; do not claim Windows support.

## 2. CodeRabbit — body comments (index; details in the raw file)
| Sev | File | Lines | Effort | Title |
|---|---|---|---|---|
| Major | `skills/ship-ticket/scripts/engine-io.mjs` | 160-162 | Quick win | Check both paths of staged renames. |
| Major | `skills/ship-ticket/scripts/engine-io.mjs` | 48-48 | Quick win | Reject short writes before replacing the ledger. |
| Major | `skills/ship-ticket/scripts/engine-io.mjs` | 153-154 | Heavy lift | Include clean tracked files in ownership snapshots. |
| Major | `skills/ship-ticket/scripts/launcher.mjs` | 61-61 | Heavy lift | Complete the launcher when the provider exits. |
| Minor | `.specs/plans/AIS-HARNESS-2.md` | 280-280 | Poor tradeoff | Provide the missing RED evidence. |
| Minor | `.specs/plans/AIS-HARNESS-2.md` | 280-280 | Quick win | Unverified finding |
| Minor | `skills/ship-ticket/references/execution-harness.md` | 290-290 | Quick win | Quote each transition in a separate example. |
| Minor | `skills/ship-ticket/scripts/carrier.mjs` | 485-486 | Low value | Preserve provider spawn errors in carrier results. |
| Minor | `skills/ship-ticket/scripts/carrier.mjs` | 512-514 | Poor tradeoff | Bound the launch handshake by timeout and cancellation. |
| Minor | `skills/ship-ticket/scripts/gate.mjs` | 441-442 | Quick win | Non-spec risk evidence is accepted based only on a nonempty path string. The engine does not visibly verify that a replay check, rollback check, or parity measurement artifact exists. |
| Minor | `skills/ship-ticket/scripts/launcher.mjs` | 60-60 | Quick win | Durable stdout truncation can discard later Codex output. |
| Minor | `skills/ship-ticket/scripts/usage.mjs` | 327-330 | Quick win | Normalize existing usage files before appending. |
| Trivial | `skills/ship-ticket/scripts/carrier-usage.test.mjs` | 533-536 | Quick win | Assert provider startup occurs after the hook completes. |

## 3. CodeRabbit — inline comments (9; severity/effort from the API)
| Sev | File:line | Effort |
|---|---|---|
| Major | references/review.md:47 | Heavy lift |
| Major | SKILL.md:425 | Heavy lift |
| Major | scripts/engine-bench.test.mjs:15 | Quick win |
| Major | scripts/usage.mjs:300 | Quick win |
| Minor | HANDOVER.md:3 | Low value |
| Minor | references/observability.md:27 | Low value |
| Minor | references/review.md:360 | Low value |
| Minor | scripts/engine-bench.mjs:85 | Low value |
| Minor | SKILL.md:423 | Low value |

## 4. Our own known follow-ups (from the AIS-HARNESS-2 ship record)
- Duplicate/stray RUN-STATE END marker hides a planted RETRY (`run-state.mjs:35`): require exactly one well-formed block; classify authority lines from BEGIN to last END; test per variant. Plus: verifyApproval ignores unparsed lines; normalization message should say the owner re-appends RETRY separately; reconcile signals unknown pgids on every drive (pgid reuse).
- N1 `mark` cannot clear some stored judgments (incl. runner quiescence_unknown, spent-retry nodes); N2 RED evidence dropped when a spec or config.base changes after build; N7 Windows nodes never reach done.
- Module sizes over ~450: carrier.mjs 603, gate.mjs 453.
- Worktree isolation deferred; real-ticket savings unmeasured.
- Define the engine's threat model in the plan (accidental/buggy workers vs deliberately hostile dispatched code) so review rounds have a bounded target.
