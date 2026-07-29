# CSV format — bulk import for Jira and Azure DevOps

One row per ticket. The full body lives in the per-ticket `.md`; the CSV
`Description` holds a **condensed but complete** version (summary + blockers +
acceptance criteria at minimum) plus a pointer to the md filename.

## Escaping rules (both trackers)

- Wrap every field in double quotes.
- Escape a literal `"` inside a field as `""`.
- Keep newlines inside a quoted field for multi-line descriptions, OR replace with
  a literal `\n` token if the target importer prefers single-line — state which in
  INDEX.md so the user imports correctly.
- UTF-8, comma-delimited. Preserve Arabic text as-is (UTF-8 handles it).

## Jira CSV columns (default)

```
Summary,Issue Type,Priority,Labels,Epic Link,Description
```

- **Summary** — the one-liner.
- **Issue Type** — Task | Story | Bug.
- **Priority** — Highest | High | Medium | Low.
- **Labels** — **one `Labels` column per label** (repeat the header). Jira's CSV
  importer maps repeated headers to a multi-value field; a single cell of
  space-separated words is the ambiguous path — Jira labels cannot contain
  spaces, and different import configs split or reject it differently. So a
  three-label ticket emits three `Labels` columns and every row must have the
  same number of them (empty cells for rows with fewer labels). Suggested labels
  only, **no sprint label**.
- **Epic Link** — the epic's **real key**, and only if you verified it exists
  (the importer cannot link to an epic that isn't there). Otherwise leave empty
  and note the intended parent in the Description. If you generated the epic in
  this same set, its key doesn't exist yet either — leave every child blank,
  import the epic row first, then bulk-set the parent. Say this in INDEX.md.
- **Description** — condensed body.

> **No estimate columns.** Do not emit `Story Points`, `Original Estimate`,
> `Remaining Estimate`, or `Effort` — a generated number is indistinguishable from
> a team-agreed one once it's in the tracker, and it feeds velocity and capacity
> planning silently. Same rule as sprint labels. If the user wants them, they
> supply the values.

> **Header count is fixed per file.** Repeated `Labels` columns mean the header
> row is written *after* you know the max label count across all tickets. State
> the count in INDEX.md so a hand-edit doesn't desync the rows.

> Jira note: the importer maps blockers/links *after* creation (keys don't exist
> yet at import time). Put "Blocked by X" in the Description; wire real issue
> links in the separate create/link step.

## Azure DevOps CSV columns

```
ID,Work Item Type,Title,Priority,Tags,Description,Acceptance Criteria
```

- **ID** — present but **left empty** for new items; Azure Boards' CSV import
  uses it to tell create-new from update-existing. **[TODO-VERIFY]** against the
  target org's import screen before a large batch — do a 1-row trial import
  first, since ADO import behaviour varies by process template and ADO version.
- **Work Item Type** — Task | User Story | Bug (AZ names).
- **Title** — the one-liner.
- **Priority** — AZ uses 1–4 (1 highest). Map: Highest→1, High→2, Medium→3, Low→4.
- **Tags** — semicolon-separated in AZ.
- **Description** — condensed body. `System.Description` is an **HTML** field, so
  markdown will render literally (`**bold**` shows as asterisks). Emit simple
  HTML (`<p>`, `<ul><li>`, `<code>`) or accept plain text with no formatting —
  pick one and say which in INDEX.md.
- **Acceptance Criteria** — AZ has a dedicated field (also HTML); put the AC
  checklist here, not only in Description.
- **No `Effort` / `Story Points` column** — same rule as Jira above.

> AZ parenting works differently from Jira's `Epic Link`: hierarchy is a *link*
> (Parent/Child), not a field, and CSV import generally won't create it. Import
> flat, then parent the items in the backlog view (or pass the relation at
> MCP-creation time). Note the chosen route in INDEX.md.

## Which one to emit

- Default: **Jira**.
- Emit **Azure DevOps** columns if the user says the project is AZ, or names AZ,
  or the repo/context indicates Azure DevOps.
- If genuinely unsure, ask once; don't emit both into one file (two schemas in one
  CSV breaks import).

## Row-per-ticket, body-in-md

Always: full spec in `tickets/<slug>.md`, condensed row in the CSV, and the CSV
`Description` ends with `(full spec: <slug>.md)` so the link back is never lost.

Sibling tickets are referenced by **slug**, not by an invented key — see the
*Ticket identity* rule in `SKILL.md`.

## The worked example

`example-tickets-import.csv` is a **2-row excerpt** of a larger generated set,
in Jira columns. Read it for: the repeated-`Labels`-column layout, the padding of
empty label cells so every row has the same column count, slug-based blocker
references, and a `Description` condensed but still buildable on its own.

**Whatever you emit, round-trip it before handing off:** the header column count
must equal every row's column count. A quoted comma or an unescaped `"` inside a
`Description` silently shifts every field after it, and the import fails (or
worse, succeeds into the wrong fields).
