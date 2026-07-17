# test-quality — PHP / PHPUnit / Pest

Concrete applications of TEST-01..09 for PHP projects. Adapted from
`amElnagdy/guard-skills` (MIT).

## TEST-02: mock boundaries in PHP

Justified:
- HTTP: Guzzle handlers/middleware (WordPress: the `pre_http_request` filter)
- External SDKs: payment gateways, mail providers, LLM clients
- Clock: inject a clock (`psr/clock`) instead of calling `time()` directly
- External filesystem (prefer `vfsStream` or temp dirs over mocking)

Unjustified:
- Mockery/Prophecy doubles for the project's own value objects/DTOs/entities —
  construct real instances (TEST-08)
- Mocking internal services to isolate a class — painful wiring means fix the
  constructor, don't fake the collaborator
- Partial mocks of the class under test — you're no longer testing the class

## TEST-03: data providers

```php
#[DataProvider('provideSlugCases')]
public function test_slugify_normalizes_input( string $raw, string $expected ): void {
    $this->assertSame( $expected, slugify( $raw ) );
}

public static function provideSlugCases(): array {
    return array(
        'lowercases'     => array( 'Hello World', 'hello-world' ),
        'strips padding' => array( '  padded  ', 'padded' ),
        'transliterates' => array( 'Café Menu', 'cafe-menu' ),
    );
}
```

Pest equivalent: `it('normalizes slug', ...)->with([...])`.

## Framework-specific notes (WordPress/Laravel)

- Integration tests: use the framework's factories (`self::factory()->post->create()`,
  Laravel model factories) — never hand-mock framework entities (TEST-08).
- Unit tests with framework functions mocked (Brain Monkey / WP_Mock): the
  mock is a justified boundary, but assert what *your code does* with the
  values — not that `get_option` was called with specific args (TEST-01).
- Don't test that the framework sanitizes, escapes, validates, or fires hooks
  — framework guarantees (TEST-07). Test your callback's behavior.

## TEST-09: real database

Framework test cases that wrap each test in a transaction against a real
schema (`WP_UnitTestCase`, Laravel's `RefreshDatabase`) exist precisely so you
don't mock the DB layer. Mocking `$wpdb->prepare` / the query builder to test
a query tests nothing.
