# Review Standard — shared findings contract for review-ish skills

The canonical report shape for code-review-style output across this library
(code-quality MODE D, angular/backend reviews, test-quality, docs-accuracy).
Domain-specific scales stay where they're genuinely better — see the
vocabulary map at the bottom. Adapted in part from `amElnagdy/guard-skills`
(MIT).

## The finding contract

A finding is: **`file:line` + the quoted code (or observed behavior) + a named
fix + a severity band.**

- The quote is what lets the author contest it; the named fix is what makes it
  actionable. *With no quote or no fix it is not a finding — it is vague
  unease. Drop it.* "Nameable" is the bar, not "codeable".
- **Never invent metrics.** No estimated quality score, no "X% cleaner", no
  maintainability index — no baseline exists, so the number would be invented.
  Count findings; don't score vibes.

## Severity bands (code-review outputs)

| Band | Means | Why the tier matters |
|---|---|---|
| **Critical** | Security, correctness, data loss, swallowed exceptions, hardcoded "success" returns | Readers/users are actively harmed; blocks merge |
| **Important** | Design defects with maintenance cost: SOLID violations, premature abstraction, param explosion, generic naming | Compounds into debt; fix before it spreads |
| **Nit** | Style, minor structure — max 3 per review, each with a fix | Noise budget: more than 3 buries the signal |

## Report discipline

- **Reconciled counts:** the summary count must equal the findings listed.
- **Coverage accountability:** one line per walked section — findings, or
  `clean`. *A blank section is an unbacked claim, not a pass.*
- **Do not manufacture praise.** A "what's good" section is 0–3 genuine,
  specific positives — omitted on a clean review, never padded.
- **Credit accuracy.** "40 claims checked, 2 false" is a good result — say so.
  Clean files aren't mentioned; clean reviews get one line.

## Scope discipline

**Review the diff, not the repo.** Pre-existing violations in files the change
didn't touch are flagged only in an explicit audit — and then marked
`pre-existing`, so they're never billed to the current author. (Deliberate
exception: `security-audit` is an audit by definition and scans whole
surfaces.)

## Contested-review protocol

When the author (or another agent) pushes back on a finding — or wants to skip
one:

1. **Skipping requires a citation.** Name the rule ID (`NG-*`, `BE-*`,
   `TEST-*`, `DOC-*`, a constitution rule) that the finding contradicts. No
   ID → fix the finding. "It conflicts with our conventions" is not a
   citation — that sentence can be written about any finding.
2. **A finding that contradicts an `[NN]` rule is never skipped.** If a
   reviewer and an `[NN]` rule disagree, you have a real problem — STOP and
   surface it.
3. **A granted exception is recorded** with the principle, the reason, and a
   revisit trigger. An exception with no exit is deferred debt — and a
   triggerless exception is itself a finding on the next pass.

(ship-ticket carries its own full copy of this protocol for workflow
self-containment; this is the canonical statement.)

## Vocabulary map — scales that deliberately stay

| Skill / context | Scale | Why it stays |
|---|---|---|
| security-audit | CRITICAL / HIGH / MEDIUM / LOW | Calibrated to real *exploitability*, not code quality — a genuinely better axis for security findings |
| Verification Passes (angular/backend/GATE 3) | PASS / FAIL / N-A per rule | Gate status, not per-finding severity — orthogonal to bands |
| ship-ticket GATE 4 | Faithful / Minor / Major / Not-built | A design-parity *grade*, not a defect severity |
| test-quality | Must fix / Should fix / Sacred / Worth noting | "Sacred" (regression tests) has no Critical/Important/Nit equivalent |
| cost-reducer | High / Med / Low priority | Savings priority, not defect severity |

When two skills report in one session, each keeps its scale; the summary maps
everything to "blocks merge / should fix / note" so the reader gets one
decision surface.
