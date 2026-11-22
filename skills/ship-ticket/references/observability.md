# Workflow observability — phase, activity, and wait timing

Load at workflow start. Timing is operational telemetry, not ticket evidence and
not part of the reviewed candidate.

## Storage and privacy

Use `scripts/run-log.mjs` from the installed `ship-ticket` folder. It resolves the
target repository's shared Git directory (`git rev-parse --git-common-dir`) and appends to:

```text
<git-common-dir>/ai-skills/ship-ticket/<TICKET>.jsonl
```

There is one file per ticket for the whole repository: the main checkout and every
linked worktree write the same file, so a run whose phases are logged from two
worktrees is not split. `--repo` may be any directory inside the work tree. This
location survives branch switches, does not dirty the worktree, and remains
available while waiting for approval, CI, or tracker operations. It is local and
is not pushed.

**The shared log is the only telemetry source (S5 cutover).** Every reader and writer uses
the shared `<TICKET>.jsonl` above, and nothing else: no runtime union, no migration.

Earlier versions wrote to `git rev-parse --git-path ai-skills/ship-ticket`. In a linked
worktree that is `<git-common-dir>/worktrees/<name>/ai-skills/ship-ticket`, a per-worktree
log. Those files are now a READ-ONLY ARCHIVE. They are never written, moved, copied,
deleted, or merged into any figure. In the main checkout the old path IS the common dir,
so its pre-S5 history already is the shared log and stays fully visible.

Normal commands touch a linked worktree's archive in one way only: `legacy_present`. That
is an `lstat` of THIS worktree's own `<TICKET>.jsonl`, and, when it is a regular file, a
newline count over at most its first MiB. It reports `{files, lines | 'unavailable',
errno?, truncated?}`, and anything that is not a regular file is
`lines: 'unavailable', errno: 'not_regular'`. No command opens another worktree's
archive. The carrier's REPAIR read is unchanged (see below).
- `summary`, the integrity line and `check` report `legacy_present` when it is non-zero.
- `check` lists it under `degraded`, with exit code 0: writes work.
- Every `start`/`end` written in a worktree that has an archive of the ticket carries the
  metric `legacy_worktree: true`, and every reader labels such a run
  `partial_legacy: 'possible'`. Part of that run may be in the archive, which no figure
  includes.

**Runs that span the upgrade (AC2-C).** A run started in a linked worktree's pre-S5 log is
not in the shared log, so this version cannot end its intervals.
- `end` refuses with zero rows written: `event a has no start in the shared log; this
  worktree has a pre-S5 log (<path>, <n> lines). A run started there cannot be ended by
  this version: close it with the build that started it, or record that it was abandoned
  with "run-log.mjs abandon --repo <repo> --ticket T --run-id R"`. In a worktree without
  an archive the text stays `event a has no start in run R`.
- `run-log.mjs abandon --repo <wt> --ticket T --run-id R [--reason
  old_build_unavailable|superseded|unknown]` is allowed only when that worktree has an
  archive of T. It reads nothing from the archive, and it is idempotent.
  - It writes one reserved ACTIVITY pair to the shared log: name `legacy_abandoned`,
    event id `legacy-abandoned.<12 hex>`, outcome `abandoned`. It is not a workflow
    interval, so the recorded run outcome is not rewritten.
  - Every reader shows that run with outcome `abandoned` (the recorded workflow outcome
    stays as `recorded_outcome`) and counts it in `abandoned_runs`, never in
    `completed_runs`. The eval report never treats it as an accepted ticket, and the
    integrity line prints ` abandoned=<n>`. **Abandonment never means success.**
- The name `legacy_abandoned` and event ids starting `legacy-abandoned` are reserved
  (AC15, case-insensitive). Every other writer refuses them: `start`, `end`, `batch`,
  `event` and `close`.
- `abandon` refuses in two cases. First, when run R does not OCCUR in this worktree's own
  archive: a run_id membership scan through the same safe read, which produces no figures;
  a missing, unreadable or non-regular archive (for example a directory named
  `<T>.jsonl`) refuses too. Second, when the shared log already holds a workflow interval
  of R that ended `complete`: a completed run is never abandoned.
- The S5 continuation of such a run (new intervals after the upgrade) IS in the shared
  log. Its figures are partial and labelled `partial_legacy: 'possible'`.

**Audit and retention of an archive.** `run-log.mjs legacy --repo <worktree> [--ticket T]`
prints that worktree's archive read-only: its rows, its warnings, and a summary computed
over that file alone, labelled `scope: 'legacy-archive'`. It is never combined with the
shared log. It uses the same safe read as `legacy_present`:
- lstat first, a regular file only, never following a symbolic link, never blocking on a
  FIFO;
- at most 64 MiB; a larger file is reported `truncated: true, bytes_read`;
- an unlistable directory is `status: 'unavailable'` with its errno, never an empty listing.

That JSON is a READABLE COMPANION only. It does not preserve the history:
- S-04 measurement rows export as zero rows;
- invalid or torn lines are dropped;
- a file over the limit is truncated.

**Before `git worktree remove`, copy the RAW files and verify the copy:**

```bash
WT=<WORKTREE>; NAME=<worktree-name>
SRC="$(git -C "$WT" rev-parse --path-format=absolute --git-path ai-skills/ship-ticket)"
DST="$(git rev-parse --path-format=absolute --git-common-dir)/ai-skills/ship-ticket/archive-legacy/$NAME"
mkdir -p "$DST"
cp -Rp "$SRC/." "$DST/"   # every file: <T>.jsonl, <T>.jsonl.lost-*.json sidecars, torn bytes, engine files
(cd "$SRC" && find . -type f -exec shasum -a 256 {} + | sort -k2) > "$DST.SHA256SUMS"
(cd "$DST" && shasum -a 256 -c "$DST.SHA256SUMS")   # every line must say OK; stop if any does not
node <SHIP_TICKET_SKILL>/scripts/run-log.mjs legacy --repo "$WT" > "$DST.readable.json"   # companion only
git worktree remove "$WT"
```

- Remove the worktree only after every checksum line says `OK`.
- The copy is inert. No run-log command reads `archive-legacy/`: tickets are only the
  files directly in the log directory, and REPAIR authority is read only from a
  worktree's own `review-auth/`. Any other location works as well.
- Without the raw copy, removing the worktree deletes that history.

**REPAIR authority stays per worktree.** The common log is telemetry and never authorises
a carrier REPAIR: every worktree writes it. A REVIEW phase start also writes a copy of its
row into a dedicated subdirectory of this worktree's own gitdir, `git rev-parse --git-path
ai-skills/ship-ticket/review-auth/<TICKET>.jsonl`. No ticket name can address that
directory: a ticket id has no `/`, so every shared write is a file directly in the log
directory. Without engine state, the carrier reads a REVIEW start only from that file and,
in a linked worktree, from its own pre-S5 `<TICKET>.jsonl` (no other worktree writes it).
A row counts only when its `ticket` is exactly the requested ticket (case-sensitive), so a
case-folding filesystem (APFS, NTFS) cannot alias one ticket's records into another's.
Ticket ids ending in `.engine` or `.review-auth`, or equal to `review-auth` or `excluded`,
are refused, compared case-insensitively. The earlier `<TICKET>.review-auth.jsonl` files
of this branch's first repair are not read by anything and keep no authority. If the copy
cannot be written, `start` exits 1 after the shared row is written, and REPAIR stays
unauthorised.

**Transitional upgrade note.** In the main checkout the old per-worktree path IS the common
dir, so a REVIEW start that a pre-S5 version recorded there does not authorise a run-log
REPAIR after the upgrade. Record a fresh REVIEW start (new event id, same
`review_execution`) with this version, or rely on engine state. A REVIEW start in a linked
worktree's own pre-S5 log keeps authorising there.

**Mixed versions and rollback.** A version before S5 never reads the common log, except in
the main checkout, where its old path is the common dir: there it reads and writes the
common file itself, which holds only single-file history (nothing is ever copied into it).
A pre-S5 build still running in a linked worktree keeps writing its own archive, which is
invisible to S5 readers (`legacy_present` grows there). After a rollback, a linked
worktree's old version stops seeing the events written since S5; they are not lost.
Never put source text, prompts, ticket descriptions, credentials,
URLs with tokens, reviewer prose, or command output in the log. Metrics are only
short booleans, numbers, or enum-like labels.

The run engine ([execution-harness.md](execution-harness.md)) writes its own
events (`MARK`, resume and retry events) to a sibling file,
`git rev-parse --git-path ai-skills/ship-ticket/<TICKET>.engine.jsonl` (per worktree). It is not a timing
log: `run-log.mjs summary --all` skips it, and `run-log.mjs` never appends to it.

Measurement events (`run-log.mjs event`, `close`) are validated against a closed schema
(`scripts/measure/events.mjs`) and written by the same single append path as `start`/`end`.
Every write takes `<TICKET>.jsonl.lock` (waiting up to 10 s) and refuses unless the whole
resulting log is valid. Bytes after the last newline (an interrupted write) are moved
verbatim to `<TICKET>.jsonl.lost-<offset>-<sha>[-<layout>].json` (the layout hash keeps two recoveries with equal bytes and first offset apart), and a `log_loss` record takes their
place, so the loss stays visible. A complete but invalid line is never dropped: every write
refuses until `run-log.mjs quarantine --repo <path> --ticket <key>` moves undecodable,
malformed and invalid measurement lines to such a sidecar (with a `log_loss` record).
Since S5 (AC12) `quarantine` clears EVERY content-level state that makes writers refuse,
to a fixed point: undecodable, malformed or invalid lines, unsupported schema, invalid
records, ticket mismatches, orphan ends, second starts of an id, and ends whose order,
duration, identity or carrier binding disagree with their start (the later row moves).
Only the 64 MiB size limit is not cleared; archive or rotate that file by hand. Because the
shared log serves every worktree, its damage blocks every worktree's writes, REVIEW starts
included, until `quarantine` runs (from any worktree).

Usage events (`usage.mjs`, carrier `usageLog`, the run engine) carry `source` (`carrier`,
`engine`, `session` or `codex`; one source per execution, never double-counted) and `role`
(`builder`, `repair`, `evidence`, `orchestrator`, `reviewer`, `unattributed`: an import given no role). Per-role totals and
the orchestrator share come from `eval.mjs report`.

### Resource and cost metrics (`eval.mjs report`)

Read-only; each prints `unknown` where its source lacks data, never 0, and none is a gate.

- `peak_rss_mb` (max over attempts) and `peak_cpu_pct`: the durable launcher samples its
  process group with `ps` (first sample at 0.1 s, then every 1 s; `ps` runs with `LC_ALL=C` so
  %cpu parses under any locale) and writes the peak to the attempt envelope (`peak_rss_mb`,
  `peak_cpu_pct`, `resource_samples`). The launcher and the `ps` itself are excluded. They cover
  WORKER attempts only: the RED and proof runner processes are not launched through the
  launcher, so their peaks are not recorded. Limits: sampled peaks, so a spike between ticks is
  missed and a worker shorter than 0.1 s has no sample; RSS double-counts shared pages;
  `peak_cpu_pct` sums `ps` %cpu, a per-process average whose window differs by OS (Linux: average
  over the process lifetime; macOS: decaying recent average), so it is an estimate and not
  comparable across OSes; the group is the launcher's, so a descendant that left it is not
  counted. Windows (no process groups), a missing `ps` or a disabled sampler
  (`SHIP_TICKET_SAMPLER_OFF=1`) give `unknown`.
- `parallel_efficiency`: sum of engine attempt durations (attempt start to envelope end) /
  (wall x `config.width`), wall being first attempt start to last attempt end. 1 means every
  slot was busy; overlap is not causal time saved. Needs the run's engine state.
- `terminal_review_outcomes`: original reviews recorded with `overflow` (a terminal FAIL).
  `retries_authorized`: RETRY authorizations consumed by a new original review. Both come from
  the engine state's review chain; `unknown` without it.
- `cost_per_accepted_ticket`: reported cost of a complete run, kept per `cost_basis` (bases are
  never added; subscription estimates are not charges). `unknown` for an incomplete run or one
  with no reported cost. `cross_run` keeps the per-basis averages.
- `tokens_by_phase`: processed tokens per usage phase; records without a phase (imports without
  `--phase`) are the `phase unknown` bucket, counted against the ticket budget only.
- `attempt_timing`: per engine attempt `wall_ms`, `api_ms` (provider-reported API time, from the engine
  state's usage record with the attempt id, or a `--usage` record) and `other_ms = wall - api_ms`. Worker
  attempts of claude carry `api_ms`; review executions do not (session and codex imports carry none), so
  review `api_ms` is `unknown`. `proof_wall_ms`: the sum over exited proof attempts of `started_at` to
  `ended_at`; `unknown` when none exists or any lacks either stamp (never a partial sum). A proof
  attempt's `ended_at` exists only with `config.auditRecord: true`, so Phase-0 plans set it.
  `unattributed_share_pct`: processed-token share of records whose role is `unattributed` (imports given
  no role).
- `truncated_outputs` (present only when any): attempts whose launcher output passed the 32 MiB
  capture cap (`{attempt_id, kind, node, stdout_bytes}`); a flag, never a changed outcome.
- `orchestrator_share_pct` is `unknown` when any usage record of the run lacks counters; a
  usage file's malformed (e.g. crash-truncated) JSONL lines are skipped, as before Wave 1.

Logging is best effort. If the helper is absent or one call fails, announce
`timing telemetry degraded`, record the reason in the execution summary when
possible, and continue the ticket. A telemetry failure never changes a workflow
outcome and never causes `WAIT_FOR_USER`.

## Start a run

Create one opaque, safe `run_id` before the first tracker or repository read. Use
the normalized ticket key/ID, not the full URL. If the target Git repository is
not known at invocation, start logging immediately after it is resolved and add
`--metric started_late=true` to the workflow start.

```bash
node <SHIP_TICKET_SKILL>/scripts/run-log.mjs start \
  --repo <TARGET_REPO> --ticket <TICKET> --run-id <RUN_ID> \
  --kind workflow --name ship_ticket --event-id workflow

node <SHIP_TICKET_SKILL>/scripts/run-log.mjs start \
  --repo <TARGET_REPO> --ticket <TICKET> --run-id <RUN_ID> \
  --kind phase --name UNDERSTAND --event-id phase-understand
```

`<SHIP_TICKET_SKILL>` means the directory containing this skill's `SKILL.md`.
Keep the same ticket and run ID for the entire execution, including later turns
that resume a legitimate wait.

### Preflight: `check`

Before `EnterPlanMode`, run the read-only preflight once:

```bash
node <SHIP_TICKET_SKILL>/scripts/run-log.mjs check --repo <TARGET_REPO> --ticket <TICKET>
```

It writes nothing (no probe file, no directory, no lock) and prints one JSON line
`{ok, append_ready, resolved_dir, legacy_present, degraded?, reason?}`. Exit 0: telemetry can be
written to `resolved_dir`. Exit 1, with `reason`: not a Git repository; an append to the
shared `<TICKET>.jsonl` or to this worktree's `review-auth/<TICKET>.jsonl` could not
succeed; the lock file is
unreadable, malformed, held by another host (`lock_foreign_host`), or stale with an
existing `<lock>.recovery` marker. These follow the same decision the next append's lock
takes, using the same process probe; check mirrors it read-only, because the lock module
has no read-only form. "Could succeed" is judged by `appendPreflight`, which mirrors the
exact operations of an append, one function for `check`, `batch` prevalidation, a single
REVIEW `start` and the authority copy itself:
- the directory, or its nearest existing ancestor when `mkdir -p` would create it, is a
  directory (not a regular file, not a dangling symbolic link) that is writable and
  searchable;
- an existing target directory is also readable, because it is opened to fsync a newly
  created file;
- the target, when present, is a regular file that is writable (not a directory);
- `<file>.lock` would be accepted as above.

Exit 1 also when the existing log would refuse writes (for example a torn tail,
`incomplete_tail`; the next write or `quarantine` moves it aside). An exit 1 is a
declared degradation of the run's telemetry: record it (`harness degraded`) and
continue. It never blocks the ticket. `degraded` lists notes that do not stop
writes: `legacy_present` (this worktree has a pre-S5 archive of the ticket; it is not read),
`stale_lock_recoverable` (a dead writer's lock the next write recovers), `lock_held` (a
live holder: the next write waits for it, up to 10 s), and
`future_history` (a row of a run is more than 5 s in the future, see below).

### Several intervals at once: `batch`


A shell variable holding several `--metric` flags is one word in zsh, so the flags
never reach the parser. Put the operations in a JSON file instead (or pass `-` and
write them to stdin):

```bash
node <SHIP_TICKET_SKILL>/scripts/run-log.mjs batch \
  --repo <TARGET_REPO> --ticket <TICKET> --run-id <RUN_ID> --ops-file <ops.json>
```

`ops.json` is an array of
`{"op": "start"|"end", "kind", "name", "event_id", "outcome"?, "metrics"?: {"key": value}}`.
Metric values are typed exactly as `--metric key=value` types them and are never
word-split, so `--` and spaces survive verbatim. A metric key must be a plain name;
a key containing `=` is refused, never re-split. A numeric value must be finite (a
400-digit number is refused, never stored as Infinity). Every op is validated before the
first write; the ops then run in order and the first failure stops the batch. A
batch is not atomic: ops already applied stay. A REVIEW start also needs its
per-worktree authority copy: if `appendPreflight` says it could not succeed, the whole
batch is refused before the first write, by the same decision `check` uses. A single
REVIEW `start` is refused the same way, with zero rows. stdout is one JSON line, `{"applied": n}` or `{"applied": n, "failed":
{"index": i, "reason": "...", "committed_shared": true|false, "authority_copy"?:
"failed"|"pending"}}` (exit 1). `applied` counts every op whose row committed to the
shared log, including a REVIEW start whose authority copy then failed
(`committed_shared: true`, `authority_copy: "failed"`). Do not retry that op: its shared
row exists, so a retry is refused as a duplicate. Record a fresh REVIEW start with a new
event id instead. No command re-copies the authority row from the shared log, because the
shared log does not record which worktree wrote a row, so a re-copy would be a new
authority source. A single `start` reports the same case on stderr
(`committed_shared=true authority_copy=failed`).

### Supplied timestamps (estimated)

`start --started-at <iso>` and `end --ended-at <iso>` record a boundary that was
not stamped when it happened. The value must be strict UTC ISO-8601
(`2026-01-01T00:00:00.000Z`). It is checked against the clock when the row is
written: not later than now + 5 s, not earlier than now - 24 h, and never earlier
than any row already recorded for the run (so a supplied value never backdates
recorded history, and an end is never before its start). A supplied `--ended-at`
earlier than a LATER row of the same run is refused too, so backfilling intervals
that overlap recorded ones is limited. A refused value writes nothing. The row
carries `timestamp_source: "supplied"` and `label: "estimated"`; `duration_ms` is
computed from the recorded pair. A row stamped by the clock is unchanged and has
neither key; when a supplied value up to 5 s ahead is already recorded, the clock
stamp is raised to it so the run's rows stay in time order. The raise never goes
beyond now + 5 s. A row more than 5 s in the future (clock skew, a hand-seeded or
an old version's `2999-...` stamp) is kept as it is, never adopted and never
rewritten. It is left out of the ordering history, reported as `future_history` by
`check` and by the integrity line, and the next rows keep the clock stamp. Ordering
therefore holds only within the 5 s skew bound. The only exception is an end whose
own start is in the future: the end is never earlier than its start.
`event --started-at/--ended-at` take the same now + 5 s / now - 24 h bounds. They
are not held to the time-order rule, because measurement events can overlap
earlier rows (concurrent review lanes), so an `event` row may be earlier than
recorded rows of its run. They carry their own `label`.

**When the checks run.** The append path (`run-log-io.mjs`) takes the bytes to append
before it takes the lock, so the stamp is computed from the log as read. The lock-held
check of that same append then re-validates the stamp against the exact bytes it is
appended after, at the moment of writing: the window (now + 5 s, now - 24 h, for
`start`, `end` and `event`) and, for `start`/`end`, never earlier than a recorded row
of the run. A supplied stamp that fails there is refused and nothing is written. A
clock stamp that a concurrent writer overtook while waiting for the lock is refused
with a retry: the command re-reads the log, re-stamps and tries again, up to 5 times.
So the bytes appended are always the bytes checked under the lock. The stamp itself is
not computed inside run-log-io.

### What the log can and cannot claim

- The log is local, unauthenticated and unsigned. Any process that can write
  `.git` can forge, edit or delete events.
- Supplied timestamps are self-asserted. They are bounded, not verified.
- The `run-log integrity` line of `ship-ready-check.mjs` (with `--repo` and
  `--ticket`) claims only what was parsed, counted and paired: events (legacy
  start/end ROWS plus S-04 events, each a start/end pair; `log_loss` records are
  counted apart), runs, open phases, warnings and `log_loss` records, plus
  `degraded=future_history(n)` when some run has a row more than 5 s in the future. It does not claim the log is complete or
  authentic. A deleted or missing log prints `unavailable`, never zero events.
- Shared observability is not shared authority. The common log never authorises a
  REPAIR; only this worktree's own gitdir does (see above).
- One source for every reader: `summary`, `check`, the writers, the integrity line and
  `eval.mjs report` read the shared log only, so their figures are the same from every
  worktree. The abandoned and partial-legacy labels come from one rule
  (`lib/run-log-paths.mjs` `labelLegacyRun`). Only the per-line parsing differs: eval's
  legacy figures read lines leniently, as before S5.
- Known limits:
  - Pre-S5 history of LINKED worktrees is in no figure. It is visible only through
    `run-log.mjs legacy` while the worktree exists, or through its export (the runbook
    above).
  - A run spanning the upgrade is split. It is labelled `partial_legacy` only when some of
    its S5 rows were written in the worktree that holds the archive. Rows written from the
    main checkout, or from any worktree without an archive of the ticket, carry no
    `legacy_worktree` mark, so such a run shows no label.
  - A pre-S5 build still running in a linked worktree writes invisibly to its archive.
  - `legacy_worktree` is not added to S-04 `event`/`close` rows (their schema is closed),
    so `partial_legacy` is judged from `start`/`end` rows.
  - A residual failure no read-only preflight can foresee (the lock still held after
    10 s, the filesystem changing between the check and the write) is reported truthfully
    (`committed_shared`) and is not undone. A REVIEW start whose authority copy failed
    after its shared row committed needs a fresh REVIEW start with a new event id.
  - A hand edit of any log file is outside these guarantees.
- Telemetry never gates a ship decision. The integrity line never changes
  `ship-ready-check`'s exit code, and a failed `check` is a recorded degradation.

## Close intervals

End an interval with the exact same `kind`, `name`, and `event-id`:

```bash
node <SHIP_TICKET_SKILL>/scripts/run-log.mjs end \
  --repo <TARGET_REPO> --ticket <TICKET> --run-id <RUN_ID> \
  --kind phase --name UNDERSTAND --event-id phase-understand \
  --outcome pass
```

End a phase before starting the next phase. On `COMPLETE` or `FAIL`, end the
current phase and the workflow. Use workflow outcome `complete` or `fail` so the
summary can classify the run.

The phase duration is wall-clock time and includes nested activities and waits.
Kind totals therefore overlap and must not be added together. Repeated phases
are summed, not replaced by their first occurrence. A missing measurement is
unknown, not zero. Raw records remain `ship-ticket-run-log-v1`; the changed
summary contract is `ship-ticket-run-summary-v2`. Existing logs are never rewritten.

## What to time

Always time the six phases. Also time these activities when they occur because
they explain most variance:

| Phase | Activity name |
|---|---|
| UNDERSTAND | `tracker_fetch`, `repository_recon`, `review_preflight` |
| PLAN | `native_plan_mode` (its end metrics carry provider/consumer contract outcomes) |
| BUILD | `contract_materialization`, `frontend_build`, `backend_build`, `integration_join`, `unit_review`, `unit_review_repair`, `unit_review_confirmation` |
| PROVE | `frontend_proof`, `backend_proof`, `shared_proof`, `runtime_attacks`, `ui_evidence` |
| REVIEW | `frontend_review`, `backend_review`, `contract_review`, `primary_review`, `optional_review`, `review_reconcile`, `review_repair`, `review_confirmation` |
| SHIP | `commit_push_pr`, `ci_wait`, `tracker_completion` |

The `unit_review*` activities in the BUILD row occur only with `config.unitReview`; their metrics are in [units.md](units.md), Timing activities.

Use a unique event ID for every occurrence, for example
`prove-repository-checks-1`. Do not create an interval for every shell command or
status message; the extra bookkeeping would distort the workflow being measured.

Give activities that were actually dispatched together the same
`--metric parallel_group=<stable-id>`. Allocate that ID per dispatch wave and
never reuse it within a run; when a later ready set is dispatched, create a new
ID even if it performs the same kind of work. Use one high-level interval per
worker or proof/review partition, not one per command. Explicit wave IDs are
authoritative: keep sequential or single-member waves visible with limitations,
rather than silently splitting or dropping them. Summaries measure concurrent
wall overlap and peak concurrency, not causal time savings. Frontend/backend
overlap uses the union of all intervals on each side. Per-wave
`concurrent_wall_overlap_ms` counts wall time with at least two members active,
not summed worker time. `frontend_overlap_pct` and `backend_overlap_pct` use
their respective side's union as denominator; `frontend_backend_union_overlap_pct`
uses the combined union. Thus 100% of the shorter side is not 100% of BUILD.
Check `timing_basis`, `carrier_timed_members` and `flags` before comparing waves.

Writer nodes dispatched through the harness carrier return `run_log_metrics`
(`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`,
`reasoning_tokens`, `reported_cost_usd`). Import them on that activity's end event with
`run-log.mjs end … --metrics-from <carrier-result.json>`, where `<carrier-result.json>` is
the carrier's **stdout** JSON saved to disk (`carrier.mjs run dispatch.json > carrier-result.json`),
not its `resultFile`, which holds only the final message. That reads the pairs directly, so
no shell has to word-split a metrics string (zsh does not). They are provider-reported counters only. An absent counter is unknown
and is not recorded as zero. A Claude subscription cost is a list-price estimate,
not a charge. Use the harness `parallel_group` (run-ID prefixed) as the wave ID.

### Execution identity and timing provenance

Before each authorized REVIEW execution, allocate `review_execution=review-<opaque>`
and attach it to its phase, reviewer, repair and confirmation events. The prefix
prevents numeric metric coercion. Record candidate ID, host/counterpart, skill
revision or content hash, configured primary/recovery/optional/confirmation
ceilings and whether deadlines are enforced. A user-authorized retry keeps the
workflow run ID but gets a new execution ID and predecessor; generating an ID
never authorizes a retry. Legacy unlabelled events remain unknown execution scope.

Use metrics `candidate_id`, `host_agent`, `counterpart_agent`, `skill_revision`,
`primary_ceiling_ms`, `recovery_ceiling_ms`, `optional_ceiling_ms`,
`confirmation_ceiling_ms`, `deadline_enforcement=enforced|advisory`, and
`previous_review_execution` on a retry. Put execution metadata on its REVIEW
phase start; put the ID and current candidate on each activity. Confirmation
binds the repaired candidate, not the initial candidate; never change identity
inside an already-started activity.

Review timing calls, per round: `start` the REVIEW phase with `candidate_id` and
`review_execution`, plus `skill_revision` and the four `*_ceiling_ms`. Then `start` each
of `primary_review` (or its partition reviews), `optional_review` (also when degraded
or unavailable), `review_reconcile`, and `review_repair` / `review_confirmation` when run,
with `candidate_id` and `review_execution`; `end` each when it actually ends. Missing
identity metrics, an invalid `gap_reason` or an oversized value refuse a start; a refusal writes nothing. A missing or invalid
`skill_revision` or ceiling never refuses: it is recorded as `unknown` and reported
`unknown`; do not retry or wait on it, because the REVIEW phase start row is what
authorizes a REPAIR. Time covered by no interval: end the phase with
`--metric gap_reason=no_start_stamp|wait|host_sleep|unknown` (a start refuses any other value). On an `end`, an invalid, over-long (over 512 characters), multi-line or repeated `gap_reason` or `skill_revision` is recorded as `unknown` with a stderr note naming the rejected value, so such a value cannot leave the interval open; the identity metrics (`candidate_id`, `review_execution`) stay strict, and an end is still refused for other malformed input (an unknown interval, a bad `--metric` form). `summary` reports
`missing_review_intervals` (a count; `unknown` without execution IDs; `at_least` with a
known sum when some runs are unknown).

Logger timestamps describe when records were appended. They must not be backdated
to make delayed result collection look like prompt completion. When the detected
carrier/version provides trustworthy start/finish timestamps, retain those
separately with their source and collection delay. A blocking-return timestamp is
valid only when completion was actually observed then; later batch collection is
not a blocking return. Manual estimates remain approximate. Never import relay
prompts, output text, stderr or credentials into telemetry.

For a supported `delegate-relay.result.v1` result, bind a fresh absolute result
path **before** dispatch (its file must not exist), and give the relay its parent
directory as `--out-dir`:

```bash
node <SHIP_TICKET_SKILL>/scripts/run-log.mjs start \
  --repo <TARGET_REPO> --ticket <TICKET> --run-id <RUN_ID> \
  --kind activity --name primary_review --event-id primary-review-1 \
  --metric candidate_id=<CANDIDATE_ID> --metric review_execution=review-<OPAQUE_ID> \
  --carrier-result <FRESH_ABSOLUTE_RESULT_JSON>
```

After collecting the result, end that same event with the registered
`--carrier-result` path and the orchestrator's assessed `--outcome`. Process
completion alone is not a passing review. The helper verifies repository,
read-only mode and dispatch binding, then imports only whitelisted timing/status
metadata plus a result digest into `carrier_timing`: `started_at`, `ended_at`,
`duration_ms`, `collection_delay_ms`, `source=relay_result`, `tool` and `status`.
Candidate/execution identity comes from the registered dispatch. The result path
and contents are not exposed in the summary. Repeating the identical import is
idempotent; do not add `--metric` on that repeated end call.

Unsupported or invalid result imports degrade telemetry, not ticket execution:
close the event normally without `--carrier-result` and report the missing
carrier measurement. Legacy/missing carrier timing uses logger intervals, which
may include deferred collection. Native Plan Mode's no-write boundary below
overrides result registration/import just as it overrides ordinary logging.

### Native Plan Mode and logging

Native Plan Mode permits read-only shell commands and must not be bypassed to
write telemetry. This exception overrides every generic start/end/wait instruction.
If Plan Mode was already active at invocation, do not start logger intervals or
exit merely to log. Keep timestamps in session context, declare telemetry delayed,
and after approval resume logging with `started_late=true`; never invent earlier
logger events. When an interactive Codex mode switch requires the user, record a
`wait` named `plan_mode_switch` while writes are still permitted. If it cannot be
closed after switching because Plan Mode forbids writes, defer closing until the
host permits logging and mark `includes_native_plan_mode=true`; do not interpret
that interval as pure user wait. Keep actual switch/debate timestamps in context.
Immediately before an available native entry transition, start the PLAN phase and a
`native_plan_mode` activity with `--metric write_suspended=true`. Do not invoke
the logger again while Plan Mode is active. Immediately after human approval
and exit from Plan Mode (Claude: approved `ExitPlanMode`; Codex: approved
implementation handoff and host mode change), end existing activity/phase intervals
with `--metric approval=approved`, then continue directly into the
after-approval work. Also record `frontend_contract=accepted` and
`backend_contract=accepted` for full-stack work. Do not open another approval
wait.

That activity's wall time intentionally includes research, cross-model debate and the
human approval wait because the read-only boundary prevents trustworthy nested
writes. While it is open, the summary reports `planning_or_approval`, not
`open_without_wait`. If Plan Mode is unavailable, log PLAN activities and the
ordinary approval wait normally. Time each `plan_debate_exchange` with its own
ID and `round=<n>` when writes are allowed. In native Plan Mode, keep exchange
start/end timestamps in the permitted plan draft or session context and persist
those in section 7 after approval; do not backdate logger events. The final PLAN
metrics carry total measured debate time without conflating it with user wait.

Useful end metrics are:

- REVIEW phase, per execution: `review_profile=standard|elevated`, `finding_count=<n>`,
  `repair_batches=0|1`, `confirmation_count=0|1`;
- PLAN phase (or `native_plan_mode` end): `host_agent=claude|codex|other|unknown`,
  `counterpart_agent=claude|codex|fable|other|unavailable`, `debate_responses=0|1|2|3`,
  `debate_calls=<n>` (includes failed attempts),
  `debate_status=converged|unresolved|degraded`, `debate_elapsed_ms=<n>`;
- `primary_review`: `finding_count=<n>`;
- `optional_review` (the mandatory second opinion; the activity name is historical): `counterpart_agent=codex|fable|other|unavailable`, outcome `pass`, `findings`, or `degraded` and metric
  `reason=timeout|unavailable|no_concurrency|tool_error`;
- PROVE phase: `repair_batches=0|1|2`;
- CI wait: `poll_count=<n>`.

Example:

```bash
node <SHIP_TICKET_SKILL>/scripts/run-log.mjs end \
  --repo <TARGET_REPO> --ticket <TICKET> --run-id <RUN_ID> \
  --kind phase --name REVIEW --event-id phase-review --outcome pass \
  --metric review_profile=standard --metric finding_count=0 \
  --metric repair_batches=0 --metric confirmation_count=0
```

## Legitimate pauses versus accidental stops

Immediately before yielding in `WAIT_FOR_USER`, start a `wait` interval with a
specific name such as `plan_approval`, `scope_decision`, `credentials`, or
`external_authority`. Do not close the phase or workflow.

```bash
node <SHIP_TICKET_SKILL>/scripts/run-log.mjs start \
  --repo <TARGET_REPO> --ticket <TICKET> --run-id <RUN_ID> \
  --kind wait --name plan_approval --event-id wait-plan-approval-1
```

On the first action after resuming, end that wait with outcome `resumed`, then
continue the still-open phase. An open phase with an open wait is an intentional
pause. An old open phase without a wait is a diagnostic lead, not proof of an
agent stop: the logger may have failed or records may be missing.

If a previous session's run ID is not in context, recover it with `summary` and
resume the latest open run for that ticket. Do not invent a second run merely
because the conversation crossed turns.

## Analyze one ticket or the experiment

```bash
node <SHIP_TICKET_SKILL>/scripts/run-log.mjs summary \
  --repo <TARGET_REPO> --ticket <TICKET>

node <SHIP_TICKET_SKILL>/scripts/run-log.mjs summary \
  --repo <TARGET_REPO> --all
```

The v2 JSON summary exposes `counters.repair_batches` and `counters.confirmations`
as `{observed, declared, declaration_complete, mismatch}`. Observed zero means no
matching activity record, not proven absence of repairs. Missing declarations
are `null`; disagreement remains explicit rather than silently choosing a count.
`review_executions` partitions these counters by recorded IDs; apply limits per
execution, not to the run-wide sum. Legacy logs cannot prove that multiple
confirmations belonged to one execution. Both primary and optional degradations
remain visible as observed counts. Check which runs have measurements before
comparing medians; older runs without provenance are not a controlled baseline.

Wall durations and REVIEW-to-BUILD ratios remain available separately from
`build_wall_excluding_recorded_waits_ms` and
`review_wall_excluding_recorded_waits_ms`: union and clip waits to the measured interval
before subtracting them. This is not active compute time, and incomplete wait
logging limits its meaning. `phase_coverage[].uninstrumented_ms` is time without
covering activity or wait evidence, not idle time. Overlapping activity totals are
not elapsed time. `durations.build_ms` and `durations.review_ms` sum all completed
occurrences, including authorized retries rather than hiding them behind the first.

Malformed, truncated or unsupported records produce integrity warnings while
valid records remain readable. Affected runs have unknown integrity-dependent
state, not a diagnosed unexpected stop. Writers refuse unsafe appends to damaged
history, including an incomplete tail; leave the file untouched and report
telemetry degradation rather than repairing history automatically. A missing end
record cannot establish whether a reviewer ran too long or was collected late.

One real ticket is a smoke test. Use three to five representative tickets before
judging the redesign. The redesign is working when:

- the primary workflow stays within its 12-minute ceiling plus at most three
  minutes for result recovery; confirmation has its separate six-minute ceiling.
  The full REVIEW phase also includes reconciliation, repair and legitimate waits,
  so its wall time is not the primary reviewer's deadline;
- REVIEW-to-BUILD time falls materially from the old workflow and does not grow
  across repeated review cycles;
- every completed run has zero open intervals;
- every intentional cross-turn pause has an open `wait` while paused;
- review repair batches never exceed one and confirmation never exceeds one per
  authorized execution, with no contradictory observed/declared counters;
- full-stack BUILD shows one group containing both `frontend_build` and
  `backend_build`, with non-zero overlap unless concurrency was declared degraded;
- optional reviewer timeouts appear as degradations, not stalled workflows.

Investigate an old open phase with no open wait against transcript/carrier
evidence before calling it a continuation defect. For the next full-stack trial,
check provenance, enforced deadlines, complete counters and real timing sources
first; do not rerun shipped tickets merely to fill missing telemetry.

## Legacy-path telemetry notes (ASTF-42 S-04a1)

- `eval` `attempt_timing[].models_used` (sorted) appears only when a usage record joined to the attempt names a model; absent means unknown. `usage.mjs` records carry the same optional string array.
- `eval` `review_round_wall_ms.excluded_unknown` also counts rounds with an unfinished interval or an open REVIEW phase: their truncated wall still prints on the round but never enters the percentiles.
- Stamps with a non-Z offset (for example `+02:00`) are normalised to UTC in `intervals` and `open_intervals`; Z stamps are untouched.
- The legacy figures of logs without offsets, models or unfinished rounds are guarded by `legacy-figures.golden.json`, captured from origin/main by `legacy-golden.mjs` (maintainer only; it archives the pinned base commit, never the working tree).

Deferred to S-04a2 (relay `exit`/`usage` import, removed from S-04a1 after two failed confirmations of the same defect class): the event
contract must define a CLOSED set of known usage keys with an explicit unknown-key rule, and settle these surviving defects. Inherited
property names (`constructor`, `__proto__`, `toString`) must not index the key table. A cap on kept unknown counters must report the
omitted count rather than drop silently. Claude's nested `output_tokens_details.thinking_tokens` needs a mapping or an explicit
"not imported". `exit` and `usage` must be validated when a log row is read (`validCarrierTiming`). Nested numerics (for example `output_tokens_details`) need an explicit decision too. Both relays' real result shapes
need fixtures (the Codex relay writes no `usage` today). Until then carrier timing imports only the whitelisted timing/status fields.

Known limit of the END leniency (S-04a1): an invalid or repeated `gap_reason` or `skill_revision` on an `end` is recorded as `unknown` and, because
start and end metrics merge with the end winning, it overwrites a valid value declared at the start of the same interval. The stderr note
names the rejected value; omitting the key instead is a candidate refinement for S-04a2.
