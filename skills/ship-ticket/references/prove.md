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
| 1 | static security rows · the parity artifact and its classifications · the attack surface inventory and abuse-case *design* · the docs scan | **yes** |
| 2 | **barrier** → one batch of fixes → re-derive to a fixed point | no — write barrier |
| 3 | live attacks | no — serial by nature |
| 4 | **barrier** → attack fixes → back to stage 2 | no — write barrier |

**Stage 1 is read-only. Every fix it identifies waits for stage 2.** A
static-security fix can change routes, middleware, config or rendering sinks —
which is exactly what the inventory and the abuse design were derived from. Fixing
mid-stage invalidates the products still being read.

**Stage 2 does not judge by feel which products "look" invalidated.** Compare the
changed file set against each product's inputs and derived scope, and re-run every
product whose inputs moved: the repo's commands, the static rows, the parity
draft, the surface inventory, the abuse design, the docs scan. A surface
enumerated before the fix that created it was never enumerated.

**Stage 4 recomputes the trust-boundary trigger and the complete inventory from
the changed tree** — an attack fix is production code and can add or move a route,
a middleware, a config boundary, a rendering sink or an outbound credential path.

Both loops increment the **mutation budget** once per batch, and both are bounded
by it. Fan-out width stays proportional to the work; four owned screens is four
concurrent parity diffs, not one agent walking four screens in sequence.

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

**Emit a security-scope digest** over the in-scope surfaces, every transitive
control owner traced (including unchanged files), those files' contents, and the
rule-inventory version, using the manifest's canonical serialization. The rule
pass may reference deterministic output bound to it — never a semantic judgment.

A fix here is production code: it re-runs the repo's commands for the files it
touched.

## The attacks

Invoke `vapt`. **This skill owns *when* the gate fires and *what artifact it
produces*; `vapt` owns the rule set, the trust-boundary taxonomy and the rules of
engagement.** Do not restate its rules here.

### When it fires

The diff introduces or changes: a request handler · an auth or session path · a
query taking external input · a sink rendering values it did not author · an
upload or path handler · client-side storage · an outbound call carrying
credentials · a queue consumer · security config (CORS, headers, cookie options,
secrets).

Skip **only** when the diff touches none of those — and name every changed file
you excluded, and why. Uncertain applicability escalates to running the gate,
never to skipping it.

### Coverage is applicability-driven, always

**Every `VAPT-*` class whose surface the diff touches is in force, in every run.**
Any class not run is declared inapplicable *with evidence*.

**`security-sensitive` adds an independent signature. It changes no coverage.** A
non-sensitive run is unsigned, never reduced. There is no reduced set selected by
a ticket's label — the only reduced set in this workflow is the missing-engine
fallback below, which is a declared degradation with a named cause.

### Local only

Attack a **local, disposable instance**. Never production, never shared staging,
no matter who owns it. Only a shared environment reachable → ✋ STOP and ask. App
cannot be run locally at all → ✋ STOP.

### The output is committed tests

Each abuse case becomes a test in **this repo's own runners**, named for the rule
it defends (`VAPT-API-01: user B cannot read user A's invoice`) and asserting the
**refusal** rather than the guard's internals. Not a report — this is why CI
blocks the merge rather than an agent's summary.

### Test by control-equivalence class — share the definition, execute per route

Eight endpoints behind one auth middleware, one serializer and one error mapper
are one control *path*. **What grouping saves is authoring, not execution.**
Identical static fingerprints do not prove identical runtime behaviour: shared
middleware branches on method, path, route metadata, parameters, resource type and
datastore state.

So write each abuse case **once, table-driven**, and **run every applicable
assertion against every in-scope route**.

Record a **control-path fingerprint** per route — registration, middleware order
and arguments, binding and schema, ownership and policy resolution, serialization,
error mapping, and the relevant configuration — and group only routes whose
fingerprints are **identical**. Differing fingerprints, or any resolved
dynamically such that you cannot compute one, are **separate classes**.

**Every route needs a positive control.** Auth-reachability alone accepts an
unregistered route, because a `404` reads as a refusal. So each route carries
**both**: an authenticated request proving the route actually resolves, **and** a
semantic rejection proving the control denies the wrong principal. Route-specific
coverage is also required for every applicable non-auth dimension the class cannot
speak for — tenancy, authorization parameters, mass assignment, injection, output
leakage, rendering.

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

### The verdict

**PASS** ⇔ a canonical **class → routes → controls → tests** map in which every
applicable rule is green for every equivalence class · every route carries its own
reachability positive control and auth rejection · any route whose equivalence to
its class is unproven carries its own full tests · zero unfixed `[NN]` findings ·
a green `test-quality` pass, or its declared `TEST | DEGRADED` row · every excluded
changed file named in the artifact · plus, when `security-sensitive`, an
independent signature bound to the gate's final scope digest.

**DEGRADED** ⇔ all of that except that named rules could not be exercised — the
skill is absent, or principals could not be built. Requires the reduced set
actually committed and green, and every unexercised rule listed by ID (or the
`untested_families` form).

**FAIL** ⇔ otherwise — including a rule marked PASS with no test behind it, or a
degradation that was not declared.

**When `security-sensitive`, the signer is dispatched, not assumed.** Spin up an
independent reviewer with no build context, brief it on the surface inventory, the
rule→test map and the abuse tests, and have it return an **unsigned** verdict
stamped with the scope digest it reviewed. It is signed at close-out, alongside
parity, once the payload is final. **A run with no dispatched signer is not
strict** — losing every independent-reviewer route is a ✋ STOP, never an implicit
downgrade.

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
