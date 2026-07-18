---
name: security
description: |
  Secure-by-default coding practices that stop fast-moving work from shipping a
  vulnerability — apply them by default, even when unasked.

  Trigger when:
  - writing auth code, or handling passwords, tokens, or secrets
  - touching environment variables
  - writing database queries
  - building API endpoints or handling file uploads
  - doing any backend work

  Do NOT use for: full-codebase security audits (use security-audit) or backend
  architecture enforcement (use backend-code-quality).
---

# Security

Secure-by-default coding for fast-moving work — the guardrails that stop a
vibecoded app from shipping an obvious vulnerability. Apply these **while
writing**, without being asked. For a full audit of an existing codebase (waves,
severity calibration, tracked findings), use the `security-audit` skill instead.

## When this applies

Nearly all backend and auth work. By topic:

| Topic | What to get right |
|---|---|
| Auth, passwords, tokens, sessions | Hash with argon2/bcrypt · JWT expiry + rotation · `httpOnly`+`sameSite`+`secure` cookies |
| Secrets & config | Secrets in env vars, never in source or tests · `.env` gitignored |
| Database & dependencies | Parameterized queries only · RLS · audit a dep before adding it |
| APIs & network | HTTPS only · explicit CORS origins · escape output · CSRF tokens · rate limits |
| Desktop (Electron) | `contextIsolation` on · `nodeIntegration` off · validate IPC |

## The rules

### Non-negotiable — never generate these

Refuse and explain why if asked to write any of them:

- **Hardcoded secrets.** `const ADMIN_PASSWORD = 'admin123'` — secrets come from env vars.
- **String-concatenated SQL.** `` db.query(`… WHERE id = ${userId}`) `` — parameterize, always.
- **Plaintext passwords.** `user.password = req.body.password` — hash with argon2/bcrypt.
- **`eval()` / `Function()` on user input** — there is no safe form of this.
- **Wildcard CORS in production.** `Access-Control-Allow-Origin: *` — list known origins.
- **Disabled TLS verification.** `NODE_TLS_REJECT_UNAUTHORIZED = '0'` — never in shipped code.

### Always — secure by default

- **Never trust the client.** Validate every input server-side, regardless of client validation.
- **Least privilege.** Every service, token, and user gets the minimum access it needs.
- **Fail closed.** When in doubt, deny. Never fail open.
- **No security through obscurity.** A hidden endpoint is not a protected one.
- **Don't leak internals.** Log stack traces server-side; return a vague message to the user.

## Secure-by-default patterns

```typescript
// ✅ Secrets from env — fail loudly if missing
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

// ✅ Validate input even on an "internal" API
function validatePipelineName(name: unknown): string {
  if (typeof name !== 'string') throw new Error('name must be string');
  if (name.length > 100) throw new Error('name too long');
  if (!/^[a-zA-Z0-9-_]+$/.test(name)) throw new Error('invalid characters');
  return name;
}

// ✅ Never expose stack traces
app.use((err: Error, _req: Request, res: Response) => {
  console.error(err);                                      // log internally
  res.status(500).json({ error: 'Something went wrong' }); // vague to the user
});
```

## Pre-PR checklist

Run before every PR — a copy-paste gate:

```
Secrets    □ no keys/tokens/passwords in source or tests  □ .env gitignored
Auth       □ argon2/bcrypt (never MD5/SHA1)  □ JWT expiry set  □ refresh rotated
           □ auth endpoints rate-limited  □ cookies httpOnly+sameSite+secure
Input      □ all input validated server-side  □ parameterized SQL
           □ uploads validate type+size  □ errors don't leak internals
Network    □ HTTPS only  □ CORS restricted (not *)  □ CSP/X-Frame-Options set
           □ rate limiting on public endpoints
```

## What this skill does not do

- Full-codebase security audits — use `security-audit` (wave scanning, severity
  calibration, `.specs/` tracking).
- Backend architecture/tenancy enforcement — that's `backend-code-quality` (`BE-SEC-*`).
- Run scanners or dependency audits — it's the judgment layer, not the tooling.

## Success criteria

Working when: secrets never reach source, every input is validated server-side,
queries are parameterized, and a request to write one of the "never generate"
patterns is refused with a reason — all without the user having to ask.

## Troubleshooting

- **Rule collides with a project convention:** the project's documented security
  policy wins; flag the exception rather than silently downgrading.
- **Unsure if something is a boundary:** treat external input, payloads, and
  cross-process data as untrusted and validate. When in doubt, fail closed.
