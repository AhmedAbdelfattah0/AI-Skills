# PROVE — the barriers, the static proof, and the attacks

Loaded when the PROVE phase starts. Parity lives in
[design-parity.md](design-parity.md).

Two claims, and they are not the same: **the control exists in the code**, and
**the control engages at runtime**. Only the second survives a middleware
registered in the wrong order or a guard whose route matcher misses the new path.
Establish the first, then test the second.

## The four stages

Almost all of stage 1 is reading, and the reads do not need each other. The rest
is ordered, because a fix changes what the later stages were derived *from*.

| Stage | What | Concurrent? |
|---|---|---|
| 1 | static security rows · the parity screen list and classifications · the attack surface inventory and abuse-case *design* · the docs scan | **yes** |
| 2 | **barrier** → write stage 1's artifacts → one batch of fixes → re-derive | no — write barrier |
| 3 | live attacks | no — serial by nature |
| 4 | **barrier** → attack fixes → back to stage 2 | no — write barrier |

**Stage 1 is read-only — it writes nothing at all, artifacts included.** Its
products are held in memory and written at the stage-2 barrier. A static-security
fix can change routes, middleware, config or rendering sinks — exactly what the
inventory and the abuse design were derived from — so fixing mid-stage invalidates
the products still being read, and writing mid-stage does the same to any reader
that picks the file up.

**The barrier runs even when stage 1 found nothing to fix.** It is where stage 1's
artifacts land, not only where fixes are applied. A clean stage 1 still passes
through it; it simply does not increment the mutation budget, because no mutation
happened.

**Stage 2 does not judge by feel which products "look" invalidated.** Compare the
changed file set against each product's inputs and derived scope, and re-run every
product whose inputs moved: the repo's commands, the static rows, the parity
draft, the surface inventory, the abuse design, the docs scan. A surface
enumerated before the fix that created it was never enumerated.

**Stage 4 recomputes the trust-boundary trigger and the complete inventory from
the changed tree** — an attack fix is production code and can add or move a route,
a middleware, a config boundary, a rendering sink or an outbound credential path.

**Record every boundary under a stable KEY, and freeze the key set with the
inventory.** REVIEW's barrier 1 compares the repaired tree against this set to
decide whether a repair introduced a surface the attacks never covered, and that
comparison is only decidable if both sides are keyed the same way:

```
kind        route | middleware | rendering sink | control path | job | listener
identity    the stable name the repo itself uses — route method+path template,
            middleware export, sink symbol, guard or policy name
authz       the permission, role, clearance or scope the boundary enforces
```

The `authz` component is part of the key, not an attribute of it: a boundary whose
predicate changes is a different boundary, because the committed tests assert the
old predicate and would pass against the new one while proving nothing about it.
A boundary whose identity the repo does not name stably is recorded as such —
REVIEW then treats it as new rather than guessing that it moved.

Both loops increment the mutation budget once per changed batch and are bounded
by it. PROVE prepares screen classifications and pinned inputs; the complete
screen comparisons happen once, inside round-1 pass A.

## The static proof

Run the routed specialist's **security rows only** — `BE-SEC-*`, `BE-AUTH-*`,
`BE-TEN-*`, or the stack's equivalents — over the changed surfaces.

**Trace the control; do not assume the diff contains it.** A surface's control
often lives in **unchanged** middleware, config or a base class. Follow each
in-scope surface through its whole static control path, including the parts this
ticket did not touch.

**Where no static mapping exists** — a hub-only stack, no specialist installed, a
control with no readable owner — say so. That half is **declared degraded**, not
proven, so the runtime test is checked against a claim you actually made.

**Emit a stable security-evidence map** listing each in-scope surface, every
transitive control owner, the applicable rule-inventory version and the named
tests. Bind the artifact to the reviewed file contents through the review
manifest; do not maintain a second scope-binding ceremony.

A fix here is production code: it re-runs the repo's commands for the files it
touched.

## The attacks

Invoke `vapt`. **This skill owns *when* the gate fires and *what artifact it
produces*; `vapt` owns the rule set, the trust-boundary taxonomy and the rules of
engagement.** Do not restate its rules here.

### When it fires

**`vapt` owns the trust-boundary taxonomy — read it there rather than from a copy
that can drift.** What this skill owns is the trigger's *strictness*: skip **only**
when the diff touches none of `vapt`'s boundaries, name every changed file you
excluded and why, and treat uncertain applicability as a reason to run the gate,
never to skip it.

### Coverage is applicability-driven, always

**Every `VAPT-*` class whose surface the diff touches is in force, in every run.**
Any class not run is declared inapplicable *with evidence*.

**`security-sensitive` requires an explicit security outcome in terminal review
and changes no attack coverage.** There is no label-selected reduced set; only a
missing-engine fallback may reduce execution, and that reduction is declared by
name.

### Local only

Attack a **local, disposable instance**. Never production, never shared staging,
no matter who owns it. Only a shared environment reachable → ✋ STOP and ask. App
cannot be run locally at all → ✋ STOP.

The artifact records stable rule IDs, route names, test names, control symbols
and outcomes. Do not maintain hand counts or use mutable line numbers as the
identity of evidence. This replaces later citation and count repairs.

Each abuse case becomes a test in **this repo's own runners**, named for the rule
it defends (`VAPT-API-01: user B cannot read user A's invoice`) and asserting the
**refusal** rather than the guard's internals. Not a report — this is why CI
blocks the merge rather than an agent's summary.

### Share the test definition; execute it per route

`vapt` owns how equivalence classes and control-path fingerprints are computed.
**The one rule this skill adds, because it is an orchestration rule and gets lost
otherwise: grouping saves *authoring*, never *execution*.** Write each abuse case
once, table-driven, and run every applicable assertion against **every** in-scope
route. Identical static fingerprints do not prove identical runtime behaviour —
shared middleware branches on method, path, route metadata, parameters, resource
type and datastore state — so a route whose equivalence to its class is unproven
carries its own full tests.

### Inventory and design fan out; attacks do not

Enumerating surfaces and designing abuse cases are read-only and parallelize
cleanly — the count is in the plan's section 8. **Running** the attacks does not:
concurrent workers share the port, the disposable datastore, the principal
fixtures, and each other's destructive state. **Live attacks run serially, full
stop.** (`vapt`'s risk-ordered waves belong to its AUDIT mode, where the run owns
its environment. This is GATE mode over one ticket's diff.)

### Fixes

An `[NN]` finding is fixed, never cited away — only an explicit recorded user
waiver clears one. A fix that changes production code re-runs the repo's commands
and the static rows for the files it touched. **Loosening or deleting the test is
not a fix.**

### Missing principals degrade loudly

Authorization classes need anonymous plus two cross-tenant users, plus roles if
the system has them. If the project cannot produce those fixtures, the affected
classes are declared **DEGRADED by ID**. They do not silently pass.

### When `vapt` itself is absent

The gate does not disappear with the skill. Run the reduced form yourself against
a local instance, **choosing the set by each surface's family** — an API minimum
asserted over a config-only surface proves nothing:

| Surface family | Reduced minimum |
|---|---|
| API / request handler | authorization across principals · tenancy isolation · mass assignment or injection on the input it takes |
| Browser / rendering sink | stored and reflected injection into the sink · authorization on the view |
| Configuration (CORS, headers, cookies, secrets) | the origin policy actually enforced · the cookie and header flags actually set |

Commit those tests in the repo's own runner and record **`DEGRADED`**. For the
rules you cannot enumerate by ID without the skill, declare
`untested_families: [...]` **plus** `rule_inventory: unavailable`. **Never invent
an ID.** With the skill installed, families instead of IDs is an under-declaration
and therefore a FAIL.

### Runtime outcome and review handoff

**PASS** ⇔ the canonical class → routes → controls → tests map is complete; every
applicable rule is green for every route; each route has its positive control and
refusal assertion; there are zero unfixed `[NN]` findings; test-quality passed or
its degradation is declared; and every excluded changed file is named.

**DEGRADED** ⇔ the executed reduced set is committed and green, while every
unexercised rule or family is named with its cause.

**FAIL** ⇔ otherwise.

PROVE runs the attacks and produces the evidence. It dispatches no reviewer.
Hand the frozen surface map, rule-to-test map, test outcomes and production
control paths to REVIEW's single terminal reviewer. That reviewer returns
`attack_review_outcome`, and `security_outcome` when required, without running
the attacks again.

### Enforcement is machine, not honour-system

The abuse tests run in the repo's existing test job. That is the enforcement that
always exists.

A merge-blocking CI check that validates the artifact — same PR-side slot as
`nn-guard` — is stronger, and **its presence is checked with the other companions,
up front**. If the repo has it, the run waits for it. **If the repo does not, say
so in the run record as a declared degradation and do not wait for a check that
does not exist.** Installing it is a repo-setup task, not something this ticket
adds after the freeze — post-freeze CI code would be unreviewed content in the
commit, which is exactly what the allowlist forbids.

Where the check does exist it accepts `PASS_FULL`, `PASS_GROUPED` or `DEGRADED`;
for `DEGRADED` it verifies each in-scope surface carries its family's reduced set,
green, and that every unexercised rule is listed by ID. A verdict it cannot parse
is a FAIL.

## Tests and docs

**`test-quality` runs once**, over the whole final test diff — ordinary tests and
abuse tests together, whether or not the attacks fired. Abuse tests are test code
and get no exemption. That single result is the evidence for the rule pass's
`TEST` row. A must-fix violation is fixed here, and any test edit re-runs the
affected tests. It is its own step precisely so a change that adds tests but
touches no trust boundary still produces `TEST` evidence rather than an empty row.

**Docs, before the freeze.** Where the diff touches docs surfaces, run the full
`docs-accuracy` guard — that is the `DOC` row's evidence, and a row backed only by
a rename grep would be overclaiming. **Additionally, wherever this ticket renamed
or changed documented behaviour** — a symbol, endpoint, flag or default — grep
every docs surface for the old name and **fix it now**. A doc edit made after the
review is unreviewed content in the commit.
