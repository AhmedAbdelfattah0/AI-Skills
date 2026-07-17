# test-quality — Python / pytest

Concrete applications of TEST-01..09 for pytest projects. Adapted from
`amElnagdy/guard-skills` (MIT).

## TEST-02: mock boundaries in Python

Justified:
- HTTP clients: `httpx`, `requests`, `aiohttp` (prefer `respx` / `responses`
  over raw mocks)
- LLM SDK calls: `openai`, `anthropic`, `litellm.completion`
- Database sessions, when the DB is not the subject (see TEST-09)
- External filesystem I/O (`tmp_path` fixture usually beats mocking)
- Clock/randomness: `time.time`, `datetime.now`, `random` (prefer `freezegun`
  or injected clocks)

Unjustified (common agent-generated violations):
- `MagicMock()` standing in for a Pydantic model or dataclass — construct the
  real thing (TEST-08)
- Mocking internal utility functions to isolate a "unit"
- Mocking `json.loads` / stdlib pure functions

## TEST-03: parametrize

```python
@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Hello World", "hello-world"),
        ("  padded  ", "padded"),
        ("Café Menu", "cafe-menu"),  # unicode reveals bugs foo/bar hides
    ],
)
def test_slugify_normalizes_input(raw, expected):
    assert slugify(raw) == expected
```

## TEST-08: real Pydantic/dataclass instances

```python
# Wrong — hides field typos and validation errors
state = MagicMock()
state.user_id = "123"

# Right — Pydantic validates the construction itself
state = UserState(user_id="123", status="ACTIVE")
```

Many fields → factory fixture or `factory_boy`, never `MagicMock` fallback.

## TEST-09: real database via fixtures

Session-scoped test DB with real migrations (`alembic upgrade head`),
function-scoped transactions rolled back per test. `pytest-postgresql`,
`testcontainers`, or SQLite-compatible fallback — the point is real schema
whenever query/persistence logic is the subject.

## pytest-specific smells

- `assert mock.call_count == N` on anything internal — TEST-01
- `@patch` stacks ≥3 deep — coupled to implementation; restructure
- `caplog` assertions on messages no caller parses — TEST-04
- Fixtures that build mocks of project classes — TEST-08; make them build
  real objects
