# PUBLISH — optional Azure DevOps or Jira work items

Load only when the user explicitly asks to publish findings from a completed
project-audit run. Publishing is a post-audit workflow, not another audit phase.
It may append publication state to the manifest and write
`tracker-draft.json`; it never changes evidence, findings, the release
assessment or the audit's terminal status.

## Authorization boundary

Separate three intents:

1. **Prepare** — select findings and build local payload drafts.
2. **Preview** — show the exact destination, types and material fields that would
   be sent.
3. **Create** — perform the external writes.

An audit request, a request to "make tickets", or approval of the report grants
only preparation until the preview has been shown. Immediately before creation,
ask one concise confirmation that names:

- `Azure DevOps` or `Jira` and the exact organization/site plus project;
- the selected finding IDs and number of items;
- the item type for each (`Bug` or `Task`);
- any assignee, area/iteration, component, labels or priority that will be sent;
- whether security-sensitive descriptions are redacted or the destination has
  been verified private.

Only an affirmative answer to that preview authorizes those payloads. Any change
to the destination, selection, type or material field invalidates the
confirmation and requires a new preview. A draft may be saved without asking for
creation confirmation. Never approve, transition, rank, assign or implement the
created items unless the user separately asks for that action.

## Inputs and defaults

Read the named run, or ask for the run ID when more than one plausible completed
run exists. Refuse to publish an `IN_PROGRESS` or unresumable run. The user
chooses:

- tracker: Azure DevOps or Jira;
- organization/site and project;
- findings: explicit IDs, a stated filter, or all findings after the resulting
  list is shown;
- item type: one type for the batch or a per-finding mapping;
- optional routing fields supported by that project.

If the user asks for a recommendation, propose `Bug` for a confirmed product
defect and `Task` for a suspected risk, coverage gap, investigation or
remediation work that is not itself a demonstrated defect. This is only a
default: show the mapping and let the user change it. Coverage degradations are
not findings and receive synthetic local IDs such as `DG-NN`; include them only
when the user explicitly selects them, and default them to `Task`.

Do not guess the tracker, project, issue type, assignee, sprint, area path,
component, labels, priority, custom field or parent. Discover them from the
connected tracker and its project schema. If the requested `Bug` or `Task` type
does not exist, report the supported types and ask the user to choose; never
silently substitute a project-specific type.

## Capability and schema preflight

Use the available authenticated connector, MCP integration or
repository-approved CLI for the chosen tracker. Before drafting:

1. verify read access to the exact organization/site and project;
2. query the project's supported work-item or issue types;
3. query required create fields and allowed values for the chosen types;
4. verify create capability without creating a probe item;
5. record only a secret-free destination identity and the capability result.

For Azure DevOps, respect process-specific work-item fields and allowed area and
iteration paths. For Jira, respect project-specific issue types, screens,
required fields and allowed components. Names differ across installations, so
derive every field rather than hardcoding cloud/server assumptions.

If read or create capability is absent, keep the draft local with status
`FAILED` and the exact closing action. Authentication secrets and raw connection
URLs containing credentials never enter the manifest, draft or report.

## Draft contract

Create `.specs/project-audit/<run-id>/tracker-draft.json` atomically. It contains:

- the audit `run_id`, system digest, draft UTC time and tracker/destination;
- a canonical `draft_digest` over the destination and ordered payloads;
- for each item: finding or degradation ID, requested type, stable marker,
  title, description, required/custom fields, sensitivity decision and state;
- attempts and confirmed external IDs/URLs, never credentials.

The stable marker is `project-audit:<run-id>:<finding-or-degradation-id>` and
appears in a field the tracker can search and in the description. It identifies
publication of this audit observation; it is not the cross-run finding
fingerprint.

Each payload includes, when applicable:

- title prefixed by the stable `PA-NNN` or `DG-NN` ID;
- audit run and pinned system digest;
- status, basis, severity and release-blocking state;
- affected repositories, components, journeys, contracts and boundaries;
- concise redacted evidence or reproduction with expected versus observed;
- remediation direction, `confirm_by` for suspected findings, and verifiable
  acceptance criteria derived from the evidence;
- a note that implementation requires a separate workflow.

Use tracker-native rich text only when its format is known. Otherwise use plain
text. Do not attach the report or evidence directory automatically: local paths
are often inaccessible to tracker readers and those files may contain sensitive
details.

## Security and privacy

Never place secrets, tokens, cookies, personal data, customer records or working
exploit material in a tracker payload. For a security finding or any report
marked `Contains exploitable details: yes`:

- verify that the chosen project and item visibility are restricted to the
  intended security/remediation audience; or
- publish a redacted item that states impact, affected surface and the safe
  internal route to obtain the private evidence.

If privacy cannot be verified, the preview must use the redacted form. Do not
offer ordinary/shared tracker publication of exploit steps as a convenience.

## Idempotent creation

For every selected item, immediately before create:

1. search the exact destination for its stable marker;
2. if exactly one item exists, record and return it as `EXISTING` without update;
3. if several exist, record `AMBIGUOUS`, create nothing, and ask the user which
   item is canonical;
4. if none exists and the confirmed draft digest still matches, create once;
5. persist the returned external ID/URL before moving to the next item.

Create items sequentially unless the tracker provides an atomic batch API with
per-item results and idempotency. Sequential writes make partial success
recoverable. After a timeout or malformed response, search the marker before any
retry. Never replay the whole batch. An environmental failure gets one retry only
after a recorded change in conditions; validation failures return to the draft
and require a new preview if the payload changes.

Publication status is:

- `DRAFT` while payloads are local;
- `WAITING_CONFIRMATION` after the exact preview is shown;
- `PUBLISHING` only during authorized writes;
- `PARTIAL` when some items are confirmed created/existing and others are not;
- `PUBLISHED` when every selected item has one confirmed external item;
- `FAILED` when no safe progress can be made, with a closing action.

Resume from `tracker-draft.json` and `manifest.publication`. Recheck tracker
capability and search every non-final marker. A prior confirmation is consumed
by the attempted batch and does not authorize changed or additional payloads.

## Completion

Return a table of finding ID, requested type, result and external ID/link. Name
all omitted findings and why, all redactions, and any partial/ambiguous result.
Creating tracker items does not change the audit's release assessment and does
not authorize fixes, branches, commits, assignments or workflow transitions.
