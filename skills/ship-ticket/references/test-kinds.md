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
`Test triggers:`, `**Test triggers**:`). The three plan keys (`test-triggers`, `lifecycle-item`, `test-waiver`) must also
lead their line, and must not start inside a word (`contest-triggers` is not a key). What may precede the key is decoration only, from a closed set of grammars:
any run of non-letters except `<` (spaces, `>`, `-`, `*`, `+`, `#`, `|`, backticks, emoji, digits in any script, so `1.`, `1.2`, `1:`, `#1`, `1000.`, `| 3 |`,
`## 2.1`, `- [ ]`); a markup tag whose quoted attribute values may contain `>` or `<` (`<b class="key">`, `<a title="a>b">`, `</b>`, nested); a tag that CONTAINS the key (`<b title="test-triggers: x">`,
`<b class="k" test-triggers: x`); an HTML comment opener, so `<!-- test-triggers: x -->` and `<!--test-triggers: x-->` still opt in; a checked task box (`[x]`, `[X]`); a roman
numeral marker of 5 or more letters in strict roman grammar, for every numeral up to 3999 (`xviii.`, `clxxxviii.`, `MCMXC)`); and a list marker of up to 4 letters (`a.`, `B)`, `iv.`,
`iiii.`), each marker followed by a space. A pictograph that NFKC would fold into a letter (`ℹ`, `Ⓜ`) counts as a symbol when it leads the line; inside the key itself the
normal NFKC reading is unchanged (`test-trℹggers:` opts in as before). Every one of those still opts in and is refused unless it is the strict line. A letter anywhere else is
prose, so the key then reads as absent and a sentence like "No test-triggers line is needed here." neither opts in nor refuses. Put the key first on its line. Prose ("this test triggers a reload") and camelCase identifiers carry no
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
Not caught (read as absent): homoglyphs, combining marks, misspellings, words joined by nothing, space-joined words
whose colon is not near them (`Test triggers (tags):`), and a plan key that does not lead its line: prose (`Note: test-triggers: none`,
``There is no `test-triggers:` line.``), label forms (`Declaration: test-triggers: x`, `**Declared:** test-triggers: x`, `Step 1: test-triggers: x`,
`Plan key -> test-triggers: x`, `- key: test-triggers: x`, `Waiver: test-waiver: x`), comparison prose led by a `<` that opens neither a tag nor a comment
(`< 5 ms; test-triggers`, `<= 3 files, so no test-triggers line`, `<3 test-triggers: x`), a comment holding prose words that closes before the key (`<!-- note --> test-triggers: x`),
and a comment opener followed by prose words (`<!-- reviewer note: no test-triggers line needed`). Residuals: a letter-run list marker that is not a valid roman numeral and has more than 4
letters (`abcde.`, `xviiii.`, `№ 5`) reads as a word; a prose line that BEGINS with a backticked key (`` `test-triggers` is not used here ``) still opts in and is refused. One well-formed RUN-STATE pair wrapped around narrative still
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

**Status: advisory.** No engine step runs `check` at freeze yet (S-01b2); the rule above is the orchestrator's. A title marker is the worker's claim and
does not prove that the test exercises the property; mutation (S-01c) and the reviewers cover that. Only the
`async-state`, `ui-lifecycle`, `entrypoint` and `shared-contract` rows are pinned by acceptance tests; the other
rows and `SURFACE_TAGS` are provisional. `async-state` and `ui-lifecycle` stay exactly as the acceptance test pins
them: add `concurrency` for overlapping or out-of-order requests (`race`) and `tenancy` or `auth` for cross-visit or
cross-user ownership. The script's declaration read is a temporary copy of the hardened git helper, to be replaced by
the shared git library (S-02a0).
