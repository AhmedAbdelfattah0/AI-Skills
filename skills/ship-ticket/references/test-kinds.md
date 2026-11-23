# Test kinds (PROVE, opt-in)

Loaded at PROVE only when the plan opts into test kinds (a `test-triggers:` line, or a repository
`.ship-ticket/test-triggers.json`); without either nothing here applies. The rest of PROVE is in
[prove.md](prove.md).

## Risk-triggered test kinds (T1-S)

Cheap checks do not catch a missing scenario. Which semantic test kinds a change needs is a **table lookup**, not a
builder's choice: `scripts/test-kinds.mjs` reads the approved plan and lists the required kinds, and before freeze
checks that a test title carries each one. Opt in per plan or per repository; with neither, nothing changes.

The kinds (`KINDS` in the script, with their definitions) follow the classes (a)-(g): `negative` (a), `race` (b),
`stale-N2` and `error-twin` (c), `lifecycle-destroy` and `ownership` (d), `contract-producer` and `contract-consumer`
(e), `real-entrypoint` (f), `regression` (g). The table (`TAGS`) maps a surface tag to kinds:

| Tag | Required kinds |
|---|---|
| `async-state` | `stale-N2`, `error-twin`, `negative` |
| `ui-lifecycle` | `lifecycle-destroy` |
| `concurrency` | `race` |
| `money` | `negative`, `race` |
| `tenancy` | `negative`, `ownership` |
| `auth` | `negative`, `ownership` |
| `input-path` | `negative` |
| `shared-contract` | `contract-producer`, `contract-consumer` |
| `entrypoint` | `real-entrypoint` |
| `repair` | `regression` |

Tags come from three places, all in the plan narrative (the RUN-STATE block never counts):

- exactly one line `test-triggers: <tag>, <tag>` (or `test-triggers: none`);
- the plan's `risk_floor:` record line (`scripts/risk-floor.mjs`), required in every opted-in plan (absent:
  `risk_floor_missing`; more than one or malformed: `risk_floor_invalid`; its `base=` differs from `--base`:
  `risk_floor_base_mismatch`). `classes=none` is the empty set. A class named like a tag is that tag;
  `risk_declaration_changed` adds nothing and `none` is reserved by `risk-floor.mjs` as a class name (a declaration change is reviewed as a declaration, not a code surface); any
  other class must be mapped by the repository, else `risk_class_unmapped`. The line is **trusted advisory input as
  recorded in the approved plan**: this script does not recompute the floor (`risk-floor.mjs reassess` does, and
  feeding its classes here is S-01b2: `kindsForClasses` maps reassessed classes through this same class loop, and
  `require` also outputs `provenance`, each required kind's sources `tag:`, `class:` and `surface:`; still advisory);
- the verified security block (`scripts/security-plan.mjs`): each surface kind maps to tags (`SURFACE_TAGS`).

A repository extends the table in `.ship-ticket/test-triggers.json`, read from the base commit only:
`{"version":1,"tags":{"<tag>":["<kind>"]},"classes":{"<risk class>":["<tag>"]}}`. It can add tags and kinds, never
remove one: a declared class mapping is united with the built-in reading of that class (`"tenancy":["repair"]` adds
`regression` to the `tenancy` kinds). Class names use the risk-floor grammar (`CLASS_NAME`, underscores allowed). When
the file exists, every plan needs the `test-triggers:` line.

Two more plan lines: `lifecycle-item: <id> <text>` makes the item a required entry of its own, covered by a test whose
title carries `[plan:<id>]`; `test-waiver: <kind or item id> <reason>` requests the owner's disposition of one requirement.
**In this slice a waiver never removes a requirement**: it is listed in `waiver_requested` (not applied, needs
trusted approval) and the kind or item stays missing. Anyone who can write the plan file can write a waiver line and a
matching RUN-STATE `START`, so the plan cannot carry that authority; applying a waiver needs the engine's pinned
approval record for the selected run (S-01b2). A waiver line inside RUN-STATE is not even a request. A plan that uses
items or waivers without the `test-triggers:` line is `plan_tags_missing`, never `not_declared`.

**Fail-closed recognition.** One recogniser (`MARKERS` in `scripts/test-kinds.mjs`) covers every marker the script reads:
`test-triggers`, `lifecycle-item`, `test-waiver`, the `risk_floor:` record and its `classes=` field, the `security-plan`
block, the `security-pairs` line and the RUN-STATE markers. It looks for each marker's token in a normalised copy of
every line (NFKC; format and default-ignorable characters such as zero-width spaces and variation selectors removed;
HTML character references such as `&#45;` decoded; inline HTML tags removed; Markdown backslash escapes removed; lower
case; unicode dashes and `_` folded to `-`). A token starts a word (`latest waiver:` carries none). Its words are joined
by dashes (or, for the three plan keys, by whitespace followed within 8 non-alphanumeric characters by a colon:
`Test triggers:`, `**Test triggers**:`), so prose ("this test triggers a reload") and camelCase identifiers carry no
token, while snake_case ones (`test_triggers`) do. The first five tokens are the bare words; the block, pairs and RUN-STATE tokens are the words
in their marker syntax (`<!-- security-plan`, `security-plan:`, a `"selection_digest":` key, `security-pairs sha256`,
`RUN-STATE:BEGIN`/`END`), because real plans use those words in prose. A line that carries a token must parse strictly
as that marker, else the marker's code (`plan_line_invalid`, `waiver_invalid`, `risk_floor_invalid`,
`security_block_invalid`, `run_state_invalid`): a bulleted, bold, re-cased, tab-separated or zero-width-damaged marker is
a refusal, never an absent one. Markers in fences or comments count. Benign: the names `risk-floor.mjs` and
`security-plan.mjs`, and the `risk_reassess:` record line (ignored here). A pairs line without its block is
`security_block_invalid`. RUN-STATE is cut at whole lines: it must be absent or exactly one `BEGIN` line followed by one
`END` line, with no other marker line in the plan (an event record, a line starting with `{`, may name the markers).
That one cut (`planNarrative`) is the only narrative every parse reads: the block is parsed from it with no second cut
(`parsePlanSecurityBlock(text, { alreadyCut: true })`), and, always, whether or not a security token remains in the
narrative, it must equal the engine's own reading of the raw plan
(`parsePlanSecurityBlock(plan)`, which cuts at substrings), else `security_block_invalid`. So an event record holding a literal
marker string refuses whenever it moves the engine's cut; this gate does not rely on the engine's own malformed-RUN-STATE
check.
Not caught (read as absent): homoglyphs, combining marks, misspellings, words joined by nothing, and space-joined words
whose colon is not near them (`Test triggers (tags):`). One well-formed RUN-STATE pair wrapped around narrative still
hides it (plan trust, S-01b2). The prose scan behind the syntax tokens covered 650 real plans, none opted in: it shows
the unopted path is stable, not that opted-in plans never refuse prose (the opted-in path is pinned by the tests).

**Tag convention.** A test title carries `[kind:<kind id>]` for each kind it proves and `[plan:<id>]` for each item
it covers, exact and case-sensitive (`[kind:negative]`; `non-negative` or `[kind:Negative]` do not count).

```text
node scripts/test-kinds.mjs require --repo <repo> --base <base sha> --plan <plan.md> > require.json
node scripts/brief.mjs build ... --test-kinds require.json --out <brief>
node scripts/test-kinds.mjs check --repo <repo> --base <base sha> --plan <plan.md> --report-file <final message file>
```

`brief.mjs build --test-kinds` lists the kinds, their definitions and the items in Required tests and asks for a
report key `test_titles` (the worker report parser accepts it; a malformed one is `test_titles_invalid`). `check`
recomputes the requirement from the plan and exits 1 with `freeze_refused` and the reasons `missing_test_kinds`
and/or `unmapped_lifecycle_item`, or `refused` with an error code (`unknown_tag`, `risk_class_unmapped`,
`risk_floor_invalid`, `risk_floor_missing`, `risk_floor_base_mismatch`, `security_block_invalid`, `surface_kind_unmapped`, `plan_tags_missing`,
`plan_line_invalid`, `waiver_invalid`, `declaration_invalid`, `test_titles_missing`). Record its `record_line`
(numbers and enums only) in RUN-STATE. **Exit 1 is never a freeze permission:** do not freeze a candidate while
`check` exits 1, as with T0's `verify`.

**Status.** The `check` command above is advisory: no engine step runs `check`, and for a run that has not opted in to
engine-enforced evidence (next section) the rule above is the orchestrator's. A title marker is the worker's claim and
does not prove that the test exercises the property; mutation (S-01c) and the reviewers cover that. Only the
`async-state`, `ui-lifecycle`, `entrypoint` and `shared-contract` rows are pinned by acceptance tests; the other
rows and `SURFACE_TAGS` are provisional. `async-state` and `ui-lifecycle` stay exactly as the acceptance test pins
them: add `concurrency` for overlapping or out-of-order requests (`race`) and `tenancy` or `auth` for cross-visit or
cross-user ownership. The script's declaration read is a temporary copy of the hardened git helper, to be replaced by
the shared git library (S-02a0).

## Engine-enforced test-kind evidence (opt-in, L-ran)

A run can opt in to a second, engine-side gate that does not use `check` or the worker's `test_titles`. The engine runs
the declared test command itself and decides from the runner's own report.

> Test-kind evidence is **L-ran**: the engine itself ran the declared test command on the exact candidate and received, through a channel no test file can write after the run, the runner's report that a test carrying the marker in its own title executed and passed. It does not show the test would fail if the behaviour broke (mutation testing and independent review cover that). It does not yet cover Angular/nx tests, tests run in a `threads` pool, or tampering with installed dependencies.

Where it applies: in an opted-in run the engine decides at the review freeze (the original and the confirmation) and at
ship-ready (before the proof, then a re-check after it), through `ensureEvidence` (`scripts/engine-gates.mjs:193`, `:339`,
`:385`). A review repair's own re-freeze is not checked; the repaired candidate cannot be confirmed or shipped until the
confirmation and ship-ready checks pass. **T0 (`fast-checks.mjs`) is not engine-enforced yet**: the engine never calls
`fast-checks.mjs` or `verify`; see [prove.md](prove.md).

### How to declare it

All of these go in the DAG and the plan, before approval (the DAG digest is bound):

1. `config.testKinds: { "policy": 1 }` (exactly that object; `scripts/engine-dag.mjs`, the `testKinds` check in
   `validateEngineDag`).
2. `config.securityPolicy: 2`. On a current approval a MISSING value is refused first as `security_policy_required`
   (`scripts/run-engine.mjs:274`, called at `:397`) and an INVALID value as `dag_invalid` (`scripts/engine-dag.mjs:133`);
   `test_kinds_needs_security_policy` (`scripts/run-engine.mjs:372`) applies only after those pass.
3. The plan opts in (a `test-triggers:` line or a committed `.ship-ticket/test-triggers.json`) and carries the
   `risk_floor:` line, as above.
4. Exactly ONE `config.testCommands` entry with an `evidence` object:
   `{"cmd":"node_modules/.bin/vitest","format":"vitest-json","args":["run","--pool=forks","--reporter=json","--outputFile={report}"],"evidence":{"report":"fd","covers":["<glob>"],"files":false,"config_paths":["<vitest config path>"]}}`.
   `{report}` becomes the report channel (`/dev/fd/3`); an optional last `{files}` arg is replaced by the changed
   test files matching `covers`, and `files` must be `true` exactly when `args` holds `{files}`
   (`engine-dag.mjs`, evidence check; the exact grammar is the allowlist in `scripts/engine-test-kinds-io.mjs`, header and
   `RUNNER`). Any other runner, flag or order is `runner_unsupported`. `--pool=forks` is part of the qualified invocation.

Refusals at `init`: `test_kinds_policy_required` (the plan or declaration opts in but the DAG has no `config.testKinds`),
`plan_tags_missing` (`config.testKinds` without an opt-in), `test_kinds_runner_missing` (no `evidence` entry),
`multi_entry_unsupported_v0` (more than one; `scripts/run-engine.mjs:370-377`).

At a gate: when no stored record fits the current evidence identity, the engine runs the runner, stores the record and
returns `evidence_refreshed` **without deciding**; re-issue the identical call and it decides on that record
(`engine-gates.mjs:474`, `:537`). `evidence_unquiet` means another attempt is live: wait for it
(`engine-gates.mjs:505`). A failing or non-zero run is `evidence_run_failed`, never "missing". A kind counts only from a
passed test whose own (leaf) title carries `[kind:<id>]` or `[plan:<id>]`, in a changed-path file that matches the test
globs and `covers`; skipped, todo and pending tests never count, and a failed test or non-zero exit fails the whole run
(`engine-test-kinds-io.mjs`, header: result, marker, file). The test's age is not checked: an old test that already
carries the marker credits when it passes, and whether it is relevant is for the reviewers. RED runs are never evidence.

### Limits

- **R-L2:** a vacuous or assertion-free test, or one that `test.fails` inverts, passes. Mutation testing and independent review cover that.
- **R-T2:** code that holds the report channel during the run can shape the report: a `threads` or `vmThreads` pool,
  main-process config code (global setup, plugins, reporters), and on Linux a same-user reopen of `/proc/<pid>/fd/N`
  (the last two are reasoned, not measured; the Linux vector is moot while the evidence channel is darwin-only,
  `scripts/engine-io.mjs:257-259`). Mitigations: `--pool=forks`, `runner_config_changed` on any change to the
  entry's `config_paths`, and the forging code being in the reviewed diff.
- **R-TC:** a worker can edit git-ignored `node_modules`, including the runner. The evidence identity and `config_paths`
  do not bind it. Review covers it.
- **R-cov:** no Angular/nx coverage; only the Vitest runner is supported. The report channel is measured on macOS
  (darwin) only: on any other platform the evidence run is refused `channel_unsupported`
  (`scripts/engine-io.mjs:257-259`), so an opted-in run needs a macOS host.
