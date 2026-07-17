# AI Failure Modes — stack-agnostic guardrails

Unlike the other references (loaded per-stack), this file applies to **every**
project regardless of stack, because it catalogs how LLMs — including the one
reading this — systematically produce bad code. Walk these before delivering
any diff. Adapted from `amElnagdy/guard-skills` (clean-code-guard, MIT) and the
primary research it cites.

Root cause behind most of them: **the model is biased toward emitting more** —
more code, more guards, more parameters, more abstraction — anything but the
minimum the spec requires. The cure is restraint. Before each line ask: *does
the spec require this, today?*

## The 15 modes

| # | Failure mode | Rule |
|---|---|---|
| 1 | **Catch-all error swallowing** — broad try/catch returning null/ok, hiding real failures (a DB outage becomes "no email") | Catch only the specific error you can recover from; otherwise let it propagate. Returning empty success from a handler is forbidden unless the contract documents it. |
| 2 | **Defensive guards for impossible cases** — null/type checks the type system or caller contract already excludes | Validate at trust boundaries (external input, payloads, cross-process data). *Inside* the boundary, trust the contract — the test is "can untrusted data reach here", not "could this theoretically be wrong". |
| 3 | **Premature abstraction** — interface/factory/strategy/base class with one concrete implementation | No abstraction without ≥2 concrete users today (or spec-required extensibility). One implementation = inline it. |
| 4 | **Comment pollution** — comments restating the code; "Step N" scaffolding left in | Comments explain *why*, never *what*. Delete paraphrase comments, step-number comments, commented-out code. |
| 5 | **Duplication instead of reuse** — re-implementing a helper that already exists (GitClear: copy-paste blocks grew 8× 2021→2024) | Before writing a function, search the repo for an existing one. ≥5 matching lines → call/extract the existing code. |
| 6 | **Hallucinated APIs/packages** — imports or methods that don't exist in the installed version (avg 19.6% package hallucination across 16 models, USENIX Sec '25) | Verify every import and external call against the installed version — read the package, check the lockfile. Never call what "should" exist. |
| 7 | **Generic intent-less naming** — `data`, `result`, `temp`, `item`, `obj`, `helper`, `handle_*`, `process_*` | Names reveal intent, or they get a qualifier (`raw_csv_bytes`, `parsed_invoice`). |
| 8 | **Long multi-purpose functions** — I/O + logic + formatting in one body (AI-assisted commits: complexity 4.2→8.1) | One function, one thing. Prompt asks for N things → N functions + a small composer. Target ≤20 lines, refactor ceiling ~50. |
| 9 | **Parameter explosion** — 6+ args that should be a typed config object | At 5 parameters, introduce a request/config object. Never boolean flag args — split the function. |
| 10 | **Inconsistency with neighbors** — new casing/HTTP client/error style in a repo that has one | Read the file + one neighbor before writing. Match casing, imports, error handling, logging; reuse existing utilities. |
| 11 | **Dead code & half-implementations** — unused imports, uncalled helpers, "just in case" exports | Lint/grep for unused symbols before delivery and remove them. Nothing ships uncalled. |
| 12 | **Declares success with mock fallbacks** — hardcoded `{"status":"ok"}` or fixture data in production paths | Never fake a result a spec says is real work. Can't implement → fail explicitly (unimplemented error) and say what's missing. Never weaken/skip a test to make it pass. |
| 13 | **Plausible-but-wrong code** — compiles, reads well, encodes a subtly wrong formula/range/null-semantic (usually copied from a similar function) | Re-derive from the spec — never copy-and-adapt a similar function. For boundaries, enumerate cases in a comment first (`empty / one / many / even / odd / null`) and cover each. |
| 14 | **Speculative configurability** — flags, env vars, `enable_*`/`*_mode` params with no present-day caller | YAGNI is a hard rule: no option without a caller today. Delete it and ship the concrete behavior. |
| 15 | **New dependency for trivial work** — a package for what stdlib or a few lines cover | Check stdlib → installed deps → a few local lines, in that order. A dependency must own real complexity (crypto, parsing, time zones), never save ten lines. |

## The floor — never cut these while simplifying

Modes 2, 14, and 11 tell you to strip speculation. These four things are NOT
speculation — removing one is a behavior change, not a cleanup. Keep it, or
flag it and ask:

- **Validation/sanitization at every trust boundary.**
- **Error handling that prevents data loss.**
- **Security measures** — authorization, output escaping, parameterized queries, secret handling.
- **Behavior the user explicitly requested** (idly mentioned ≠ requested, but never drop what was asked for).

## Refactoring discipline

A refactor preserves observable behavior: same inputs → same outputs, same
exceptions, same side effects, same ordering (Fowler, *Refactoring*). Spot a
bug mid-refactor → flag it separately and ask; **never bundle a bug fix into a
refactor**. If the diff changes behavior, it isn't the refactor that was
approved.

**Pre-flight gate:** before starting a refactor, state (to yourself or the
user) what observable behavior must NOT change. If you cannot tell whether an
edit is behavioral — a deleted guard, a removed `finally`/close/cleanup path,
a reordered side effect — **stop and ask**; "simplification" that deletes a
contract the caller relied on is a behavior change wearing a cleanup costume.

## Sources (primary)

GitClear "AI Copilot Code Quality" (2025) · Spracklen et al., USENIX Security
'25 (package hallucinations) · Fowler, "Patterns for Reducing Friction in
AI-Assisted Development" + *Refactoring* · Karpathy on LLM exception-fear ·
arXiv 2409.19182, 2411.01414, 2402.13013 · Sandi Metz, "The Wrong Abstraction"
· McCabe (1976).
