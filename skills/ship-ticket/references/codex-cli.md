# Codex transport

Load only when Codex is the selected counterpart. Host routing, PLAN debate,
stopping policy and REVIEW fallback live in [cross-model.md](cross-model.md).

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
explicit per-call `--timeout` (initial 10 minutes, delta 5 minutes, configurable).
Set `--out-dir <bundle root>/r<n>` inside the session scratch directory, outside
the repo, so every round's `brief.txt`, `result.json` and `events.jsonl` sit under
one bundle root for `debate-check` and `debate-retain`. Read `status`, `exitCode`,
`finalMessage` and `threadId` from `result.json` after completion.

For a delta or a timeout recovery, use that exact `--session <threadId>` and
repeat directory, read-only and effort flags. One resume is allowed per timeout;
a timeout alone is never a debate limit. Without a usable session, start a fresh
session carrying the delta and the ledger (the stopping ladder in cross-model
policy), or follow the Fable fallback, rather than restarting the repository read.

### PLAN carrier probe

Real-relay compatibility inside native Plan Mode is UNVERIFIED until this manual probe passes in a real Plan Mode session. The
repository's tests drive the probe with a fake relay; that proves the probe's
parser and classifier only, never the real carrier. Run it at PLAN start, after
`EnterPlanMode`, from the target repository root (a Git repository: the relay
refuses an untrusted directory unless `--skip-git-repo-check`, which the probe
never passes):

```bash
node <SHIP_TICKET_SKILL>/scripts/brief.mjs debate-probe \
  --relay "<installed-codex-delegate>/scripts/relay.mjs" \
  --repo "<target-repo>" --out-dir "<session scratch>/plan-probe"
```

It runs `codex --version` and `codex login status`, then three relay dispatches
(each with `--cd <repo> --read-only --effort high`) and prints one JSON object
whose `codex_route` goes into the plan header. Pass criteria, each recorded
separately as pass or fail with a class (`permission_denied`, `auth`, `provider`,
`relay`):

| Capability | Pass when |
|---|---|
| `dispatch` | the relay file exists, `codex --version` and `codex login status` exit 0, and a no-op read-only dispatch writes a `result.json` with `status: completed` |
| `fresh_result` | that `result.json` is readable, has a new non-empty `threadId` and answers the probe's nonce |
| `resume` | a second no-op turn with `--session <threadId>` completes and returns the same `threadId` |
| `cancellation` | a busy brief with a valid `--timeout` (default `30s`): a child process of the relay is observed, the relay reports `status: timeout`, and no process of that child's process group survives; a relay that returns before a child starts is a dispatch failure, never a cancellation pass |
| `coverage` | `candidate-id.mjs` identity (tracked diff, untracked file content, modes, symlinks) and the `git status --porcelain --ignored` listing are unchanged before and after; reported as "candidate identity and untracked-content hash unchanged; ignored files out of coverage" |

The output's `relay_kind_verified` is always `false`: the script cannot tell
whether `--relay` is the real relay or whether it ran inside Plan Mode, so the
orchestrator records both facts beside `codex_route`. To cross-check the
real relay by hand, run the same dispatches yourself and read each `result.json`:

```bash
R="<installed-codex-delegate>/scripts/relay.mjs"; O="<session scratch>/plan-probe-manual"
echo 'Do not read or change anything. Reply with exactly: probe-ok manual' | \
  node "$R" --cd "<target-repo>" --read-only --effort high --timeout 5m --out-dir "$O/dispatch"
echo 'Reply with exactly: probe-ok manual' | node "$R" --cd "<target-repo>" --read-only \
  --effort high --timeout 5m --session "<threadId from $O/dispatch/result.json>" --out-dir "$O/resume"
echo 'Do not change any file. Run the read-only shell command `sleep 600`, then reply done.' | \
  node "$R" --cd "<target-repo>" --read-only --effort high --timeout 30s --out-dir "$O/cancel" &
sleep 10; ps -A -o pid=,ppid=,pgid=,command= | awk -v p=$! '$2 == p'   # the codex child and its pgid
wait; ps -A -o pid=,pgid= | awk -v g=<that pgid> '$2 == g'           # must print nothing
```

Expect `status: completed` and a `threadId` in dispatch, the same `threadId` in
resume, `status: timeout` in cancel with a child seen during the run and none of
its process group left afterwards, and an unchanged `candidate-id.mjs --repo
<target-repo> --base HEAD` before and after. To check coverage
against an existing untracked file, create one before the probe and confirm the
probe still passes (an edit to it makes `coverage` fail). A host permission
prompt for the relay is the owner's normal approval; never request a broad allow
rule or a Plan Mode bypass. The only permission you may suggest, as the owner's
choice, is one exact-command rule for the relay invocation. A failed capability
is reported with its class and the authorized policy follows: the Fable
substitute with `carrier.degraded: true` and the frozen acknowledgement, else
`WAIT_FOR_USER` or an explicit owner exception.

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
second-opinion budget; these commands have no relay timeout flag. A native timed wait
is not such a watchdog. Without enforcement/cancellation, treat Codex as
unavailable: run the Fable fallback, and `WAIT_FOR_USER` if Fable cannot
produce a result. The second opinion is never skipped; required primary
handling is in [review.md](review.md).
Supply the exact merge-base-to-working-tree retrieval recipe,
all untracked candidate files, candidate ID, ACs and exclusions. Start fresh,
concurrently with the primary workflow. Result and fallback policy are shared
with the Claude route in [cross-model.md](cross-model.md).
