---
name: cost-reducer
description: >
  Teaches Claude how to identify and implement cost-reduction opportunities across
  AI agents, SaaS products, cloud infrastructure, and codebases. ALWAYS trigger
  this skill when the user mentions: high API bills, expensive cloud costs, optimizing
  spend, reducing token usage, cutting infrastructure costs, reviewing architecture
  for savings, or when about to recommend a paid service that has a cheaper alternative.
  Also trigger when generating AI agent code — always apply cost-aware patterns by default.
---

# Cost Reducer Skill

## When to Use This Skill

- User mentions costs, bills, or budget concerns
- Reviewing or designing AI agent architecture
- Choosing between cloud services or tiers
- Writing code that calls external APIs (LLMs, storage, DB)
- Designing SaaS product features that have usage-based costs
- Any architecture review — always include a cost lens

Read the relevant reference file based on the context:

| Context | Read |
|---|---|
| AI agents, LLM API calls, token usage | `references/services-and-finops.md` |
| Code patterns, caching, batching | `references/code-level-savings.md` |
| Cloud infra, storage, compute, DBs | `references/cloud-and-infra.md` |

---

## STEP 1 — Identify the Cost Driver

Before optimizing, understand what's actually expensive:

```
□ Is it compute? (CPU/memory/serverless invocations)
□ Is it storage? (DB reads/writes, object storage, bandwidth)
□ Is it AI/LLM tokens? (input tokens, output tokens, embeddings)
□ Is it third-party API calls? (per-request pricing)
□ Is it over-provisioned resources? (idle VMs, unused tiers)
□ Is it developer time? (complexity that slows iteration = costs money)
```

Name the top 1-2 cost drivers before proposing any solution.

---

## STEP 2 — Apply the Cost Reduction Hierarchy

Always try in this order (highest ROI first):

```
1. ELIMINATE  — Do you need this at all? Can the feature be cut?
2. CACHE      — Can the result be reused? (memory, Redis, DB, CDN)
3. BATCH      — Can requests be grouped? (fewer API calls, bulk ops)
4. DOWNGRADE  — Can a cheaper model/tier/service do the same job?
5. COMPRESS   — Can inputs/outputs be smaller? (prompt trimming, pagination)
6. SCHEDULE   — Can this run off-peak or async? (avoid peak pricing)
7. SELF-HOST  — Is the managed service 10x the self-host cost?
```

---

## STEP 3 — Report Savings Clearly

Always quantify when possible:

```markdown
## Cost Finding: [Area]

**Current cost driver:** What's expensive and why
**Estimated monthly impact:** $X or X% reduction (if calculable)

**Recommended fix:**
- What to change
- How to implement it (with code snippet if relevant)

**Trade-offs:**
- What you give up (latency, complexity, features)
- Is it worth it at current scale?

**Priority:** High / Medium / Low
**Effort:** Hours / Days / Weeks
```

---

## STEP 4 — Cost-Aware Code Defaults

When writing any code that touches paid services, always apply these by default:

```typescript
// ✅ Always add caching before external calls
// ✅ Always paginate — never fetch all records
// ✅ Always set timeouts on external requests
// ✅ Always use the smallest model that can do the job
// ✅ Always log token usage / API call counts in dev
// ❌ Never poll when webhooks/events are available
// ❌ Never store full LLM responses if only part is needed
// ❌ Never use premium tier if free tier covers the use case
```

---

## Reference Files

- `references/services-and-finops.md` — AI services, LLM pricing, SaaS cost patterns
- `references/code-level-savings.md` — Caching, batching, lazy loading, pagination patterns
- `references/cloud-and-infra.md` — Azure, Cloudflare, storage, DB, compute optimization
