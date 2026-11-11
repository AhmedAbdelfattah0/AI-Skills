# Worker brief

Use this at BUILD, when you hand a node to a writing subagent or write the prompt file for an engine
node. `scripts/brief.mjs` builds the brief from the approved DAG and checks it, so every brief carries
the same limits and the same completion format. It is a tool for you, the orchestrator. The engine does
not call it and does not read the brief.

## Build a brief

```text
node scripts/brief.mjs build --dag <dag.json> --node <id> --plan <plan.md> [--recon <json>] [--notes <file>] --out <file>
```

- `--dag` is the bound execution DAG, `--node` the node id, `--plan` the approved plan file.
- `--recon` is optional: a JSON array of recon answers with `question`, `answer`, `paths`,
  `signatures`, `quoted_lines` and `confidence` (the schema in `references/understand.md`). Without
  it the Reuse inventory section says `none recorded`.
- `--notes` is optional: a text file with what only you know. It is copied under Notes as a quotation.
- `--out` is the brief file. For an engine node, point the node's `promptFile` at it.

The output is the same every time for the same inputs: no clock, no random value, no absolute path.
Its last line is `brief-digest sha256:<hex>`, the digest of everything above it, taken after
line ends become Unix line ends; this is the only place line ends are normalised. The plan digest in
the second section is the engine's own plan digest, over the plan file as it is, so a plan that has no
run-state block is refused. A DAG or recon field that holds a newline, another control character or,
where it is shown in backticks, a backtick is refused with the field named (exit 2). Free text (the
plan step, recon answers, notes) is shown as a quotation, and `lint` also fails on a repeated section or
one outside the list. `build` will not write to a symbolic link or over its own input files.

## What the brief contains

In this order: Task (the node's row from the plan's DAG table), Approved plan and digest, Ownership
(the node's `writes`), Forbidden paths (`othersOwned`, plus the rule that other workers are active and
nothing outside ownership may be edited), Dependencies and reads, Exclusive resources, Required tests
(`redSpecs`, `checks`, and the evidence kinds the node's risk labels require), Reuse inventory, Acceptance
ids, Notes, Worker rules (no commit, no branch switch, no install, no whole-repository formatter, no
contract change) and Report block.

The Report block is a fenced `ship-ticket-report` example with exactly the keys `tests`, `red_seen`,
`blockers` and `needs_outside_ownership`. The format is the one in `references/execution-harness.md`.

## Base drift

Record the base SHA at `init`; leave `config.base` as is. At BUILD start, before freeze
and before SHIP run
`node scripts/base-drift.mjs check --repo <R> --base <SHA> --target <ref> --dag <dag.json>`.
Exit 1 (overlap): `WAIT_FOR_USER`; after the user accepts the move, re-record the base SHA.
Exit 3 (git or input failure): fix the input and rerun; not a user decision.

## Check a brief

```text
node scripts/brief.mjs lint <brief>
```

`lint` exits 1 and names the section when Ownership, Forbidden paths, Required tests, Reuse inventory
or Report block is missing or empty. It also warns, without failing, when the digest line no longer
matches the text above it, which means the file was edited after it was built. Run it on every brief
before dispatch.

## What you still add by hand

The tool knows only what is in the DAG, the plan and the recon file. Put anything else in the notes
file: a decision the owner made after the plan was approved, a trap a recon answer did not cover, the
exact test command if the plan does not name it, or the reason a path is read-only. Keep the notes short
and factual. Do not paste secrets, tokens or personal paths into them.

If a node's `writes` or `othersOwned` is wrong, fix the DAG and rebuild; do not edit the brief to
widen what a worker may touch.

## Source

Adapted from `strategy/coordination/handoff-templates.md` at commit 8ae6164 of
msitarzewski/agency-agents, MIT, Copyright (c) 2025 AgentLand Contributors.
