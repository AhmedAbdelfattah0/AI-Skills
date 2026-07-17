# docs-accuracy — Verification Procedure

The mechanical heart of this skill: turn a document into a list of claims,
then check each claim against its source of truth. Adapted from
`amElnagdy/guard-skills` (MIT).

## Step 1: Extract the claims

Scan the doc and list every:

- Function, method, class, constant, hook, event name
- CLI command, subcommand, flag, default value
- HTTP endpoint, method, status code, request/response field
- Config key, env var, file path, directory-layout claim
- Version number, compatibility statement, dependency requirement
- Behavioral claim ("retries three times", "case-insensitive", "idempotent")

Inline code spans and code blocks are claim-dense; **prose hides claims in
verbs** ("automatically reconnects" is a claim).

## Step 2: Verify each claim type

| Claim type | Source of truth | How |
|---|---|---|
| Symbol exists | The codebase | Grep the **definition** (`function name`, `class Name`, `def name`, export) — not usages |
| Signature | The definition site | Read params, defaults, return; compare name-by-name with the doc |
| CLI flag | The arg-parser source, or `--help` if runnable | Read the parser registration; flags in README but not the parser are hallucinations |
| Endpoint | Route registration (router file, annotations) | Match path, method, and handler |
| Config key | The code that **reads** it (`getenv`, config schema) | A documented key nothing reads is dead documentation |
| Default value | The definition, not the docs of the definition | Defaults drift silently; read the current line |
| Version claim | Changelog, git tags, dependency manifests | "Since 2.3" must appear in the 2.3 changelog or tag diff |
| Behavioral claim | The implementation path | Trace the claimed behavior (retry loop, case fold, guard clause) |
| Internal link/anchor | The target file/heading | Resolve the relative path; slugify the heading and compare |

## Step 3: Record what you verified

Write-time: keep a claim → file:line trail in working notes (not the doc).
Review mode: that trail IS the evidence — every finding cites the definition
site that contradicts the doc.

When the runtime allows execution, prefer executable checks: run `--help`, run
the sample, run a link checker. When it doesn't, source-reading is the floor —
never skip to "it looks right".

## When you cannot verify

1. Say so explicitly rather than guessing.
2. Downgrade the claim to what you can verify ("the client calls `/v2/orders`"
   → verified in client code, even if the server is unreachable).
3. Never decorate an unverified claim with confident language — "should",
   "appears to", or a direct question to the user beats a fluent hallucination.
