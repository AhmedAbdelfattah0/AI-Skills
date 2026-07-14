# Webhook Safety — Reference

The ordering is universal across every stack. The two implementations below are reference
implementations — pick the one matching your runtime and adapt names to your provider.

## The invariant order

1. Read the **raw bytes** of the body (not a re-serialized object — signatures are over bytes).
2. **Verify the signature** with a **constant-time** comparison. Reject on failure → `401`.
3. **Parse** the body, guarded. Malformed → `400` (never an unhandled `500`).
4. **Replay check, fail closed.** Missing/invalid/old timestamp → reject (`400`).
5. **Idempotency** via a uniqueness constraint on the provider event id. Insert first;
   duplicate-key error → already processed → `200`.
6. **Process** inside try/catch. Success → `2xx`. Failure → `5xx` so the provider retries.
7. **Audit** every outcome. **One signing secret per provider.**

---

## Reference impl A — Web Crypto (Workers / Deno / Bun / edge)

No Node `crypto`/`Buffer`. `crypto.subtle.verify` does the constant-time compare for you.

```ts
const enc = new TextEncoder()

function hexToBytes(hex: string): Uint8Array | null {
  const s = hex.trim().toLowerCase().replace(/^sha256=/, '')
  if (!s || s.length % 2 || /[^0-9a-f]/.test(s)) return null
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16)
  return out
}

export async function verifyHmacSha256(rawBody: string, sigHex: string, secret: string) {
  if (!sigHex || !secret) return false
  const sig = hexToBytes(sigHex)
  if (!sig) return false
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
  )
  return crypto.subtle.verify('HMAC', key, sig, enc.encode(rawBody)) // constant-time
}
```

## Reference impl B — Node

Use `crypto.timingSafeEqual`; never compare hex strings with `===`.

```ts
import { createHmac, timingSafeEqual } from 'node:crypto'

export function verifyHmacSha256(rawBody: string, sigHex: string, secret: string): boolean {
  if (!sigHex || !secret) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest() // Buffer
  let provided: Buffer
  try { provided = Buffer.from(sigHex.replace(/^sha256=/, ''), 'hex') } catch { return false }
  if (provided.length !== expected.length) return false // timingSafeEqual throws on length mismatch
  return timingSafeEqual(provided, expected)
}
```

> Other ecosystems: Python `hmac.compare_digest`, Go `hmac.Equal`, Ruby
> `Rack::Utils.secure_compare`, PHP `hash_equals`. All are constant-time — use them.

---

## Replay check (fail closed) — any language

```ts
const REPLAY_WINDOW_MS = 5 * 60 * 1000
export function isReplayOrStale(createdAt: string | undefined): boolean {
  const ts = new Date(createdAt ?? '').getTime()
  if (Number.isNaN(ts)) return true                       // missing/garbage → reject
  return Math.abs(Date.now() - ts) > REPLAY_WINDOW_MS
}
```

## Idempotency — constraint, not check-then-insert

A `SELECT`-then-`INSERT` is racy: two concurrent redeliveries can both pass the check.
The uniqueness constraint is the real guard.

```sql
-- store table
... CONSTRAINT uq_webhook_event UNIQUE (event_id) ...
```

```ts
const { error } = await store.insertWebhookEvent({ event_id, provider, type, payload })
if (error?.code === '23505') return ok({ status: 'already_processed' }) // duplicate key
if (error) throw error
// ... then process
```

(`23505` is Postgres `unique_violation`; use your datastore's equivalent duplicate-key signal.)
