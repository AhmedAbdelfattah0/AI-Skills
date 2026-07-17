# docs-accuracy — Code Sample Rules (DOC-02)

A code sample is the most-trusted part of any documentation: readers paste it.
That trust makes a broken sample worse than no sample. Adapted from
`amElnagdy/guard-skills` (MIT).

## The shippable checklist

1. **Imports resolve** — every import/require/use exists in the documented
   package at the documented version.
2. **APIs are real** — names, argument order, defaults, and return shape match
   the definitions (verify per `verification.md`).
3. **Self-contained or explicit** — no implicit prior state; prerequisites
   stated (`pip install x`, "requires the table from step 2").
4. **No local residue** — no `/Users/you/...` paths, no machine-specific env,
   no leftover debug flags.
5. **Syntactically valid** — the block parses in the language it's fenced as.
6. **Output shown is output produced** — if the doc shows a result, it's the
   real result of running the sample, not an idealized one.

## Realistic data

`foo`/`bar` hides bugs that "Café Münster" reveals. Use realistic values, and
**always include at least one non-ASCII string** in samples that process text —
unicode is where slugify/encode/length bugs live.

## Secrets hygiene

- Placeholder tokens that *look like* placeholders: `YOUR_API_KEY`, never a
  realistic-looking key (it trains readers to paste theirs, and trips secret
  scanners).
- Documentation IPs from RFC 5737 (`192.0.2.x`, `198.51.100.x`, `203.0.113.x`)
  and example.com domains.

## Error paths

At least one sample per surface shows the failure: what the raised error looks
like and what the caller should do — using the error types the code actually
raises. Happy-path-only samples produce catch-all error swallowing downstream
(the exact failure `ai-failure-modes.md` mode 1 exists to stop).
