# test-quality — LLM Application Rules (TEST-10 … TEST-12)

Three additional rules for projects that call LLM APIs, use agent/workflow
frameworks (LangGraph, CrewAI, custom state machines), or wire observability
(Langfuse, LangSmith, OpenTelemetry). Apply on top of TEST-01..09. Adapted
from `amElnagdy/guard-skills` (MIT).

## TEST-10 — Prompt tests test the contract, not the content

Prompt text changes constantly; tests pinned to wording rot within a week.
Never assert specific phrasing.

Do test:
- The prompt template exists and loads (smoke test)
- Variables substitute correctly — no leftover `{placeholder}` markers
- Required structural markers exist *only if the caller parses them* (a JSON
  schema block, a delimiter the parser splits on)

## TEST-11 — Observability is infrastructure

Don't unit-test telemetry wiring. The violation pattern:

```python
# Violation — tests wiring, not behavior
mock_tracer.assert_called_once_with(session_id=..., tags=[...])
```

Mocking observability to *prevent side effects* is fine and often necessary.
Asserting on the mock's call args is not: if telemetry breaks, dashboards show
it; a unit test asserting wiring only breaks refactors.

## TEST-12 — Agent and flow tests test transitions

For agent frameworks and state machines: given a state plus an event, the flow
reaches the correct next state with the correct fields set. Mock the LLM to
return controlled responses.

**Test: state in → state out.**

Don't test: the exact prompt string sent to the LLM, the number of LLM calls,
or internal retry logic — implementation details (TEST-01) that change with
every model upgrade.

Recommended shape: a **data-driven transition table** (TEST-03) — starting
state, mocked LLM response, expected resulting state.

## Severity

- **Must fix:** TEST-12 violations asserting prompt strings or call counts —
  they break on every model/prompt change
- **Should fix:** TEST-10 wording assertions
- **Worth noting:** TEST-11 — flag it, don't block a small change on it
