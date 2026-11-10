# Security risk — how the vapt catalog is applied to a ticket

Loaded when PLAN, PROVE or REVIEW handles security-relevant work. It describes
what `scripts/security-plan.mjs` and the engine do (policy 2); it adds no rule of
its own beyond them.

## 1. Ownership

[`vapt`](../../vapt/SKILL.md) owns the control catalog (`skills/vapt/controls.json`),
its evaluator (`controls.mjs`) and the attack classes. This file owns how
ship-ticket applies them: what the plan states, what the engine binds, what review
must cover. Fallback if `vapt` is not installed beside this skill: the catalog is
absent, `security-plan.mjs` refuses `catalog_missing`, and a policy-2 run cannot
start; never substitute an empty selection or a guessed list.

The `VAPT-ABUSE-*` classes have no static `BE-*` mirror; they are proven only by
the committed specs below.

## 2. When plan §3a is required

Required when any of these holds: the change is ELEVATED, security-sensitive, has
non-empty `riskLabels`, or a `vapt` trigger fires. Otherwise §3a is the single
line `No security-relevant surface: <evidence>`. Policy 2 itself (the DAG keys
below) is required for every run approved after the cutoff (section 11), so a
no-surface run still binds `controlCoverage: []`, an evidenced empty assessment.

## 3. Writing the security facts

Facts are the input to selection. Each fact in the catalog's `fact_vocabulary`:

- comes from a **complete inventory** of the changed surfaces
  (`surfaces[]`: `boundary_id`, `kind`, `path`, `principals[]`); `boundaries` and
  `principals` are derived from it and must not be supplied differently;
- carries a **citation**, a `path[:symbol]`, in `evidence`;
- is **explicitly unknown** when it is: `"unknown: <why>"`. Never default to
  `false`; an unknown fact keeps its controls selected;
- uses only vocabulary values (`fact_out_of_vocabulary` otherwise).

## 4. Running select

```text
node scripts/security-plan.mjs select --facts <file|-> [--catalog <path>]
```

Input: `{ security_policy: 2, surfaces, facts, evidence, summary? }`. Output: the
selected controls and `<boundary>:<control>` pairs, the excluded controls with
reasons, unknown facts, a `config_fragment`, and `rows_md`, the §3a body with the
`security-pairs sha256:<hex>` line and the `<!-- security-plan: {...} -->` machine
block. Exit 0 is a result; exit 2 a refusal (`catalog_missing`, `catalog_invalid`,
`fact_uncited`, `control_unpaired`, ...); exit 1 malformed input. **Any refusal is
`WAIT_FOR_USER`** with the code; a missing catalog is never an empty selection.
If Node is unavailable the helper is a declared degradation: the plan says so
and treats every `[NN]` control as applying.

## 5. Exclusions, waivers, NOT_APPLICABLE

An excluded control is listed in §3a with the catalog's reason for the cited
facts. An approved pair can be dropped only by a `SECURITY_WAIVER` (below), an
owner-authority event for exactly one candidate. `NOT_APPLICABLE` in a review row
is **not** a waiver; it is accepted only for a pair that has a trusted waiver.

## 6. Binding into the DAG

The plan's DAG carries three config keys, none defaulted:
`securityPolicy: 2`, `catalogDigest: "sha256:<hex>"` (the catalog bytes the plan was
approved against) and `controlCoverage: [{ boundary, control, node, specs: [{file,
name}] }]`. The pair id is `<boundary>:<control>`, parsed on the **last colon**
(boundary ids may contain `:`). Each pair has its own named spec(s), never shared
with another pair; the spec file lives inside the node's existing `writes`. A spec
that would sit outside the existing node paths is a contract expansion:
`WAIT_FOR_USER`. A non-empty `controlCoverage` needs a formatted
`config.testCommands` runner, because the proof parses each spec's result. `init`
refuses with `security_policy_required` (post-cutoff run without policy 2),
`security_pairs_mismatch` (the narrative's `security-pairs` line or machine block
does not match the DAG's pairs and digest) and `catalog_unavailable` (catalog
missing or not the one approved).

## 7. Reassessment

`gate reassess` re-evaluates the candidate against the approved plan. Its input is
`{ classifications: [{ signal_id, facts?, evidence?, reason? }], surfaces?: [{ boundary_id,
kind, path, principals[] }] }`. `surfaces` are new or changed boundaries the candidate
introduces inside the Design Contract; they are unioned with the approved block's
surfaces, so a new route or auth surface produces new pairs (`ADD_CONTROLS`, then
`addendum_required` until an owner `SECURITY_ADDENDUM`). No classification, by reason,
by cited facts or both, closes a `new-route`, `auth-or-middleware-change` or
`migration-or-rls-change` signal on a path that is not an approved surface (facts never
add a boundary): it closes only through an input surface at that path whose pairs cover
the signal's control class. Input `surfaces` are
not stored: every later `gate reassess` call must supply them again, or the signal
reopens (it fails closed). A surface outside the Design Contract is a REAPPROVAL basis.

**Proving a pair spec (attribution rule).** Under TAP, a passing test carries no file
location, so a pair spec counts as passed only when the formatted command runs exactly
that one spec file (one non-option argument, a relative path, options written
`--flag=value`). A whole-suite command, a glob, a directory or an absolute path proves
nothing for TAP; jest and vitest results carry their file and are unaffected. Name one
spec file per formatted command in the plan. A same-named test in another file never
discharges a pair.

Reassessment runs when the orchestrator calls `gate reassess`, not automatically on
every engine run: at the start of PROVE, after every PROVE or REVIEW repair that
touches mapped files, and fresh before review and before ship-ready. The freshness
check (section 8) makes review and ship-ready fail closed if a call was skipped.
Mechanical signals (a match creates
a signal, never a control): `new-dependency`, `migration-or-rls-change`,
`infra-or-ci-config`, `env-or-secret-reference`, `auth-or-middleware-change`,
`new-route`, `mail-or-notification-send`, `payment-or-stock-or-wallet-call`, plus
`out-of-plan-path`. A signal already covered by the approved pairs of its class
needs nothing. Any other stays open (`reassess_unclassified`) until it is closed: by
a classification, or, for the three surface kinds on a path that is not an approved
surface, only by an input surface at that path (rule above).

| Signal | Control class that covers it |
|---|---|
| `new-route` | `VAPT-API-01`, `VAPT-API-02`, `VAPT-API-03` |
| `auth-or-middleware-change` | `VAPT-API-02`, `VAPT-API-03`, `VAPT-CFG-04`, `VAPT-ABUSE-08` |
| `migration-or-rls-change` | `VAPT-API-01`, `VAPT-ABUSE-07` |
| `mail-or-notification-send` | `VAPT-ABUSE-02`, `VAPT-ABUSE-03` |
| `payment-or-stock-or-wallet-call` | `VAPT-ABUSE-04`, `VAPT-ABUSE-05`, `VAPT-ABUSE-07` |
| `env-or-secret-reference` | `VAPT-CFG-03` |
| `new-dependency`, `infra-or-ci-config` | none: never covered mechanically, always need a classification |

A surface closes a signal only when its kind, with the merged facts, selects every
control of that class. A kind that selects less leaves the signal open (it fails
closed): declare the kind that matches the change, or `unknown`, which selects every
boundary-gated control. A classification whose `signal_id` matches no signal is ignored.

| Outcome | Meaning | Next |
|---|---|---|
| `UNCHANGED` | no new pair follows | recorded as `SECURITY_REASSESSED` |
| `ADD_CONTROLS` | new pairs inside the contract | an owner `SECURITY_ADDENDUM` adds them (add-only); `addendum_required` until then |
| `REAPPROVAL` | catalog digest changed or a path outside the contract | new START and plan digest; `WAIT_FOR_USER`, `drive` stops |

A classification can only raise facts; it can never remove an approved pair.

## 8. Freshness

The recorded reassessment must match the tuple **candidate_id + approved plan
digest + catalog digest + effective addendum set**. If any part moved, review and
ship-ready refuse `reassess_stale`; a review made under an older catalog or
addendum set refuses `security_review_stale`.

Recovery differs by code:

- `reassess_stale` is cleared by running `gate reassess` again on the current
  candidate. No `RETRY` is needed.
- `security_review_stale` needs an owner `RETRY` and a new independent review,
  never a free refresh.
- A recorded `REAPPROVAL` is permanent for the run: `S.security.reapproval` is never
  cleared, and a new START digest yields `approval_mismatch`. Recovery is a new run
  (re-init) with a new plan.

Any change to the bytes of `controls.json` gives a new catalog digest, which makes
in-flight policy-2 runs stale or `REAPPROVAL` by design. Where the skills auto-update
is installed, an update that carries a catalog change does this mid-run.

## 9. Review coverage

- The primary returns exactly one `rule_row` per effective pair
  (`subject_id: '<boundary>:<control>'`), with evidence from the pair's spec. A
  missing or duplicated pair row is refused with `incomplete_contract`.
- `NOT_APPLICABLE` only for a waived pair (`security_row_escape` otherwise).
- `security_outcome: NOT_TRIGGERED` is rejected while any unwaived pair is
  effective (`security_outcome_escape`).
- Both `[NN]` and `[D]` pairs need a passing spec or a waiver.
- A **skipped spec is not a pass**; `gate ship-ready` adds `control_unproven` per
  pair lacking an accepted RED, an unrewritten spec and a named pass in the proof.
- The effective set is a floor for the primary, not a ceiling for the counterpart:
  it receives the security plan and returns findings only.
- A repair that touches a pair's spec file makes the second opinion required.

## 10. One source of applicability

| Concern | Owner |
|---|---|
| Profile, routing, labels: spine "Security sensitivity", ELEVATED, `HIGH_RISK`, `CONFIRM_SECOND_OPINION` | unchanged; ship-ticket |
| Which attack classes apply to a change | the catalog, via `select` and `reassess` |

A label never invents or removes an attack class.

## 11. Grandfathering

A run whose trusted START was approved before `SECURITY_POLICY_CUTOFF` (in
`engine-dag.mjs`) runs unchanged without policy 2, byte for byte. The START time
is `approved_at`, or `timestamp` when absent; a missing or unparseable time fails
closed. A later run without `securityPolicy: 2` is refused at `init` and
`verifyBinding` with `security_policy_required`.

Events: `SECURITY_ADDENDUM` and `SECURITY_WAIVER` are authority events (see
[ship.md](ship.md)); one appended while dispatched work is live is untrusted and
refused. `SECURITY_REASSESSED` is engine-recorded.
