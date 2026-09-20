# Codex transport

Load only when Codex is the selected counterpart. Host routing, PLAN debate,
budgets and REVIEW fallback live in [cross-model.md](cross-model.md).

## CLI contract — verified on `codex-cli 0.145.0`

Run `codex --version`; recheck `codex review --help` if the version differs.

- `codex review` accepts a scope flag OR a custom prompt, never both.
  `--uncommitted`, `--base`, and `--commit` each conflict with `[PROMPT]`,
  including `-` stdin. An instructed review states its scope in the prompt;
  a scoped review omits the prompt and returns ordinary `[P1]`/`[P2]` findings.
- `codex exec` accepts `-s read-only`, not `--read-only`; the latter belongs to
  the delegate relay.
- Root the invocation in an actual Git repository, not its parent directory.
  Read-only sandboxing does not confine reads to that subtree. For an approved
  multi-repository scope, list absolute roots and identify the primary root.
- The final report may appear twice: deduplicate it. Normalize absolute paths
  against the correct repository before presenting findings.
- Always set `-c model_reasoning_effort=high` (relay: `--effort high`). Do not
  inherit a potentially much slower global effort setting or lower it per ticket.

## PLAN carrier

Use the installed `codex-delegate` read-only relay. Its skill is discovered by
name, not via a sibling-relative path. Read its transport instructions; do not
run its implementation workflow. It needs both the relay and the binary.

Send the brief on stdin, with `--cd <repo> --read-only --effort high` and an
explicit `--timeout` within the debate's remaining budget. Leave `--out-dir`
at its temporary default outside the repo, subject to host Plan Mode permissions.
Read `finalMessage` and `threadId` from `result.json` after completion.

For a delta or bounded timeout recovery, use that exact `--session <threadId>`
and repeat directory, read-only and effort flags. Recovery requests completed
findings only and consumes the debate's existing time and response budget.
Without a usable session, record the degradation and follow the required PLAN
counterpart pause in cross-model policy rather than restarting the repository read.

## REVIEW carrier

The binary plus a verified watchdog/cancellation route suffices; absence of the
PLAN relay alone does not disable REVIEW. Prefer the existing read-only relay
when available, with its explicit `--timeout` set to the remaining budget.
Otherwise use `codex exec -s read-only -c model_reasoning_effort=high` with the scope
packet on stdin. An instructed `codex review` is also valid:

```bash
codex review -c model_reasoning_effort=high "<instructions including exact scope>"
```

For bare binary commands, use the host's verified external watchdog within the
optional budget; these commands have no relay timeout flag. A native timed wait
is not such a watchdog. Without enforcement/cancellation, skip the optional
opinion with a degradation; required primary handling is in [review.md](review.md).
Supply the exact merge-base-to-working-tree retrieval recipe,
all untracked candidate files, candidate ID, ACs and exclusions. Start fresh,
concurrently with the primary workflow. Result and fallback policy are shared
with the Claude route in [cross-model.md](cross-model.md).
