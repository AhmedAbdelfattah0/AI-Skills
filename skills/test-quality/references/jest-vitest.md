# test-quality — JavaScript / TypeScript / Jest / Vitest / Angular

Concrete applications of TEST-01..09 for JS/TS projects. Adapted from
`amElnagdy/guard-skills` (MIT).

## TEST-02: mock boundaries in JS/TS

Justified:
- Network: prefer `msw` (Mock Service Worker) over `jest.mock`-ing your own
  fetch wrapper — it mocks at the *true* boundary
- LLM / third-party SDK clients (`openai`, `@anthropic-ai/sdk`, Stripe, …)
- Timers/randomness: `vi.useFakeTimers()` / `jest.useFakeTimers()`, seeded RNG
- Filesystem and `process.env` in Node code

Unjustified:
- `jest.mock('../utils/helpers')` — mocking your own module to isolate a "unit"
- Prototype-patching a class's private method (TEST-01)
- Object literals pretending to be domain entities when a real constructor or
  factory exists (TEST-08)

## TEST-03: test.each

```ts
test.each([
  ['Hello World', 'hello-world'],
  ['  padded  ', 'padded'],
  ['Café Menu', 'cafe-menu'],   // realistic data — unicode reveals bugs foo/bar hides
])('slugify(%s) → %s', (raw, expected) => {
  expect(slugify(raw)).toBe(expected);
});
```

## Snapshot discipline

Snapshots are implementation tests in disguise unless the snapshot IS the
contract (a public JSON output, a CLI's help text). Avoid snapshots of full
component trees (break on every styling tweak — TEST-01) and large objects
nobody reviews — **an unread snapshot approves itself** (TEST-04). Prefer
targeted assertions: `expect(screen.getByRole('button')).toHaveTextContent('Save')`.

## UI component tests (React & Angular)

- Test what the user sees and does — Testing Library queries by role/label —
  not component internals, state hooks, or signal wiring (TEST-01).
- Don't test that React renders, Angular's change detection runs, routes
  resolve, or `@Input`s propagate — framework guarantees (TEST-07).

### Angular addendum

- TestBed: construct real services where they're cheap; mock only at the
  HttpClient boundary (`provideHttpClientTesting` / `HttpTestingController`),
  not your own state services (TEST-02/08).
- Don't assert `detectChanges()` call counts or OnPush internals (TEST-01).
- Signals: assert the rendered output or the signal's value after an action —
  not that `set`/`update` was called (TEST-01).
- A component test that only checks `expect(component).toBeTruthy()` catches
  nothing — delete or replace with a behavior assertion (TEST-04).

## TEST-09: real persistence

For data-layer logic (Prisma/Drizzle/Knex/Supabase queries), run against a
real test database — `testcontainers`, Dockerized Postgres, or SQLite where
compatible. Mocking the query builder to test the query builder tests nothing.
