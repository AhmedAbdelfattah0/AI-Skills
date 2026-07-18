---
name: cost-reducer
description: |
  Identify and implement cost-reduction opportunities across AI agents, SaaS,
  cloud infrastructure, and code — and apply cost-aware patterns by default when
  generating code that touches paid services.

  Trigger when:
  - the user mentions high API bills, cloud costs, optimizing spend, token usage,
    or cutting infra costs
  - you're reviewing architecture (always add a cost lens)
  - you're about to recommend a paid service that has a cheaper alternative

  Do NOT use for: correctness or security review (use the code-quality family),
  or quoting exact live prices without verifying them via the researcher skill.
---

# Cost Reducer

Spend less without breaking things. Name what's actually expensive, then attack
it in ROI order — and write cost-aware code by default so savings compound
instead of needing a cleanup later.

## When this fires

- The user mentions costs, bills, or budget.
- Designing or reviewing AI-agent architecture.
- Choosing between cloud services or tiers.
- Writing code that calls paid services (LLMs, storage, DB).
- Any architecture review — always include a cost lens.

By context:

| Context | Focus |
|---|---|
| AI agents, LLM API calls, tokens | Model tiering, prompt caching, batching, output caps |
| Code patterns | Caching, lazy loading, pagination, N+1 elimination |
| Cloud infra, storage, DBs | Right-sizing, storage classes, egress, serverless vs always-on |

## Step 1 — Identify the cost driver

Understand what's expensive before optimizing:

```
□ Compute? (CPU/memory/serverless invocations)
□ Storage? (DB reads/writes, object storage, bandwidth)
□ AI/LLM tokens? (input, output, embeddings)
□ Third-party API calls? (per-request pricing)
□ Over-provisioned resources? (idle VMs, unused tiers)
□ Developer time? (complexity that slows iteration)
```

Name the top 1–2 drivers before proposing anything.

## Step 2 — Apply the cost-reduction hierarchy

Try in order — highest ROI first:

1. **ELIMINATE** — do you need this at all? Can the feature be cut?
2. **CACHE** — can the result be reused? (memory, Redis, DB, CDN)
3. **BATCH** — can requests be grouped? (fewer API calls, bulk ops)
4. **DOWNGRADE** — can a cheaper model/tier/service do the same job?
5. **COMPRESS** — can inputs/outputs be smaller? (prompt trimming, pagination)
6. **SCHEDULE** — can it run off-peak or async?
7. **SELF-HOST** — is the managed service ~10× the self-host cost?

## Step 3 — Report savings clearly

```markdown
## Cost Finding: [Area]

**Current cost driver:** what's expensive and why
**Estimated monthly impact:** $X or X% (if calculable)

**Recommended fix:**
- what to change · how to implement it (code snippet if relevant)

**Trade-offs:** what you give up (latency, complexity) — worth it at this scale?
**Priority:** High / Medium / Low   **Effort:** Hours / Days / Weeks
```

## Step 4 — Cost-aware code defaults

When touching paid services, apply by default:

```
✅ Cache before external calls        ❌ Never poll when webhooks/events exist
✅ Paginate — never fetch all rows    ❌ Never store full LLM responses if part suffices
✅ Timeouts on external requests      ❌ Never use premium tier if free covers it
✅ Smallest model that does the job
✅ Log token/API-call counts in dev
```

## What this skill does not do

- Judge correctness or security — that's the code-quality family and `security`.
- Quote live prices from memory — verify current pricing/limits via `researcher`.
- Micro-optimize prematurely — optimize the named top driver, not everything.

## Success criteria

Working when: every recommendation names the driver and a rough $/% impact,
fixes are proposed highest-ROI-first, and new code ships cost-aware by default
(caching, pagination, right-sized models) without being asked.

## Troubleshooting

- **No numbers available:** estimate an order of magnitude and label it an
  estimate — a ranked qualitative list still beats none.
- **Savings vs. latency/complexity tension:** state the trade-off and let the
  user decide at their current scale; don't silently trade one for the other.

## Reference Files

None — self-contained. (Deep-dive references on LLM pricing, code-level savings,
and cloud infra may be added later; verify current prices/limits with the
`researcher` skill before quoting them.)
