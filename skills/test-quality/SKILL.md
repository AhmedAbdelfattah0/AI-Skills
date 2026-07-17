---
name: test-quality
description: >
  Quality gate for generated or changed TEST code in any language — the layer
  that stops AI test bloat: mock abuse, implementation-detail assertions,
  near-duplicate test bodies, and tests that catch nothing. ALWAYS trigger
  when: a coding agent (including you) has just written or edited tests, before
  presenting or committing them; the user says "write tests for X", "add
  tests", "test this", "review these tests", "are these tests good?"; or a
  diff contains test files — *.spec.ts, *.test.ts, *.test.js, test_*.py,
  *_test.py, *Test.php, *_test.go, or files under tests/, __tests__/, spec/.
  Also trigger on /tq.guard. Can guide test writing when invoked before the
  work. DO NOT USE for production/implementation code review (use the
  code-quality family), CI or test-runner configuration, running or debugging
  tests (use the project's runner), or coverage-percentage discussions.
---

# test-quality — review test code before it ships

You are reviewing generated or changed test code before it ships. Be a sharp
reviewer, not a pedantic one: flag what wastes maintenance effort or hides real
bugs; ignore cosmetic preferences. Once this skill is active, keep applying it
to every later test change in the session.

Why this exists: coding agents over-generate tests. The systematic failures:
mock-heavy unit tests that assert implementation details, near-duplicate test
bodies differing by one value, and tests that re-verify the framework instead
of the project's logic. Each looks productive in a diff and costs maintenance
forever.

## Modes

- **Guard-pass** (default, run it without being asked): after tests were
  written/edited, check the diff against the rules, fix violations, report.
- **Live**: invoked before writing tests — apply the rules while writing, then
  self-check before delivery.
- **Review**: user asks to review/audit tests — report findings, don't edit
  unless asked.

## Adapt to the project first

1. Project instructions win: read CLAUDE.md / AGENTS.md / `.code-quality.md`
   testing rules if present — they override this skill on conflict.
2. Identify the stack, then read the matching reference:
   - Jest / Vitest / Angular TestBed → `references/jest-vitest.md`
   - pytest → `references/pytest.md`
   - PHPUnit / Pest → `references/phpunit.md`
3. If the project calls LLM APIs, agent frameworks, or telemetry → also
   `references/llm-app-testing.md` (rules TEST-10..12).
4. Map the system boundaries: network, DB, filesystem, clock/randomness,
   third-party SDKs, LLM APIs. Existing fixtures usually reveal where the
   project already draws these lines.

## The rules (TEST-01 … TEST-09)

When writing a new test, first answer: **"What specific bug does this catch
that no other test in this suite catches?"** No clear answer → don't write it.

- **TEST-01 — Test behavior, not implementation.** Assert return values and
  observable side effects from the caller's perspective. Never assert that an
  internal helper was called with specific args — that test breaks on every
  refactor while catching nothing.
- **TEST-02 — Every mock must be justified.** Mock only at system boundaries:
  network/HTTP, LLM APIs, databases (when not the subject), external
  filesystem, clock/randomness, third-party SDKs. Never mock internal classes
  or helpers to isolate a "unit". When you mock a boundary, assert what the
  caller *does with the response*, not the mock's call args.
- **TEST-03 — One scenario per test, data-driven variants.** Tests sharing
  identical setup that differ only in values merge into one parametrized test
  (`test.each`, `@pytest.mark.parametrize`, `#[DataProvider]`). Separate tests
  are correct when setup, assertions, or mocks genuinely differ.
- **TEST-04 — Every test justifies its existence.** Delete tests that only
  catch typos, verify data-class defaults, assert log-message strings no
  caller parses, or test trivial pass-throughs.
- **TEST-05 — Name tests for the scenario.** `test_<scenario>_<expected_outcome>`
  — reads like a requirement, not an echo of the function signature
  (`test_malformed_response_falls_back_to_default`, not
  `test_parse_response_missing_field`).
- **TEST-06 — Production regression tests are sacred.** A test reproducing a
  real bug is always justified — reference the incident in the name or a
  comment; never delete it. Exempt from TEST-04: the incident is the
  justification.
- **TEST-07 — No tests for framework guarantees.** Don't test that the
  validation library validates, the ORM commits, or the router 404s. Smell: a
  test that would still pass with all project code deleted.
- **TEST-08 — State and value objects are real, never mocked.** Construct
  real DTOs/entities/models. Mocking state hides field typos and validation
  errors — exactly the bugs worth catching. Painful construction is design
  feedback: add a builder, don't mock.
- **TEST-09 — Infrastructure under test gets real infrastructure.** When
  query/schema/persistence logic IS the subject, run against a real test DB
  with real migrations. Mocking the session there tests nothing. Mocking the
  DB is fine when persistence is only a side effect.

## Severity

| Tier | Rules | Why |
|---|---|---|
| **Must fix** | TEST-01, 02, 08 | Hide real bugs or break on every refactor |
| **Should fix** | TEST-03, 04, 05, 07 | Bloat and maintenance drag |
| **Sacred** | TEST-06 | Never delete; always allow |
| **Worth noting** | TEST-09 | Architecture — flag, don't block small changes |

A **must-fix** violation ⇒ FAIL in any verification row that cites this skill
(the `TEST` row in angular/backend verification passes).

## Reporting

```
**TEST-NN violation** in `tests/path/file.ext::<test_name>`
- What: <one sentence>
- Fix: <one sentence>
```

Group by file; clean files aren't mentioned. Close with
`test-quality: <N> fixed, <M> flagged` — or `test-quality: clean`. Never
invent a coverage or quality score.

## Scope discipline

Review the test diff, not the whole suite. Pre-existing violations in tests
you didn't touch are flagged only in an explicit audit, marked `pre-existing`.
Full findings contract: `../code-quality/references/review-standard.md` (if
absent — standalone install — the rules in this file suffice).

## What this skill does not do

- Run tests — that's the project's runner.
- Enforce style — that's the linter.
- Decide *what* to test — only *how* to test it.
- Review production code — the code-quality family owns that.

## Success criteria

Working when: generated test files with MagicMock state, duplicated bodies, or
log-message assertions come back as "do not merge" with rule-by-rule fixes;
data-driven tests replace copy-paste variants; regression tests survive
refactors untouched.

## Troubleshooting

- A flagged mock the author defends: ask "is this a system boundary?" — if
  the mocked thing is the project's own code, TEST-02 stands.
- TEST-03 merges feel forced: if setups differ, they're genuinely separate
  scenarios — don't merge; the rule only targets value-only variants.
- The suite has project conventions that conflict: the project wins (Adapt
  step 1); note the exception.

---

*Adapted from `amElnagdy/guard-skills` (test-guard, MIT). Sources:
`references/sources.md`.*
