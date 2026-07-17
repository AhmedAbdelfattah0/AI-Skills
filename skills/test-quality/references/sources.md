# test-quality — sources

Central bibliography. Other files use source names, not inline URLs; read this
only when a citation is needed.

## Origin

- `amElnagdy/guard-skills` — test-guard skill (MIT), the adapted base:
  https://github.com/amElnagdy/guard-skills

## Primary craft sources

- Kent Beck, *Test-Driven Development: By Example* — behavior-first testing.
- Martin Fowler, "Mocks Aren't Stubs" — classical vs mockist testing; why
  boundary-only mocking: https://martinfowler.com/articles/mocksArentStubs.html
- Martin Fowler, "Patterns for Reducing Friction in AI-Assisted Development" —
  "declares success despite failing tests"; never weaken a test to pass.
- Kent C. Dodds, "Testing Implementation Details" — the TEST-01 argument for
  UI: https://kentcdodds.com/blog/testing-implementation-details
- Testing Library guiding principles — query by role/label, test what users
  see: https://testing-library.com/docs/guiding-principles/
- Sandi Metz, "The Magic Tricks of Testing" (RailsConf) — message-based rules
  for what to test and what to delete.

## Tooling references

- msw (Mock Service Worker) — true-boundary HTTP mocking: https://mswjs.io
- pytest parametrize / freezegun / testcontainers docs
- PHPUnit data providers; Pest `with()` datasets
