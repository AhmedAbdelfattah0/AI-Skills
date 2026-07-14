---
name: security
description: >
  Teaches Claude the most critical security practices when vibecoding — building
  apps fast without accidentally shipping dangerous vulnerabilities. ALWAYS trigger
  this skill when: writing auth code, handling passwords or tokens, touching
  environment variables or secrets, writing database queries, building API endpoints,
  handling file uploads, or doing any backend work. Security is not optional —
  apply it by default even when the user doesn't ask for it.
---

# Security Skill

## When to Use This Skill

Security applies to nearly all backend and auth work. Read the relevant reference:

| Topic | Read |
|---|---|
| Auth, passwords, tokens, sessions, secrets | `references/auth-and-secrets.md` |
| Database queries, SQL, dependencies, supply chain | `references/database-and-deps.md` |
| Electron, desktop apps, local file access | `references/desktop-security.md` |
| APIs, CORS, XSS, CSRF, headers, rate limiting | `references/web-security.md` |

---

## STEP 1 — Security Checklist (Run Before Every PR)

```
Secrets & Config:
□ No API keys, tokens, or passwords in source code
□ All secrets in environment variables (.env, not committed)
□ .env is in .gitignore
□ No hardcoded credentials in tests

Auth:
□ Passwords hashed with bcrypt/argon2 (never MD5/SHA1)
□ JWT tokens have expiry set
□ Refresh tokens are rotated on use
□ Auth endpoints are rate-limited
□ Session cookies have httpOnly + sameSite + secure flags

Input & Data:
□ All user input is validated server-side (never trust client)
□ SQL queries use parameterized statements (never string concat)
□ File uploads validate type + size + scan for malware
□ API responses don't leak internal error details

Network:
□ HTTPS everywhere (no HTTP fallback)
□ CORS is restricted to known origins (not *)
□ Security headers are set (CSP, X-Frame-Options, etc.)
□ Rate limiting on all public endpoints
```

---

## STEP 2 — Default Secure Patterns

Always write code this way from the start:

```typescript
// ✅ Environment variables — never hardcode
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

// ✅ Input validation always — even if "internal" API
function validatePipelineName(name: unknown): string {
  if (typeof name !== 'string') throw new Error('name must be string');
  if (name.length > 100) throw new Error('name too long');
  if (!/^[a-zA-Z0-9-_]+$/.test(name)) throw new Error('invalid characters');
  return name;
}

// ✅ Never expose stack traces to users
app.use((err: Error, req: Request, res: Response) => {
  console.error(err);  // log internally
  res.status(500).json({ error: 'Something went wrong' });  // vague to user
});
```

---

## STEP 3 — Red Flags to Never Generate

If asked to write any of the following, refuse and explain why:

```typescript
// ❌ NEVER — hardcoded secret
const ADMIN_PASSWORD = 'admin123';

// ❌ NEVER — SQL string concatenation
db.query(`SELECT * FROM users WHERE id = ${userId}`);

// ❌ NEVER — store plain text password
user.password = req.body.password;

// ❌ NEVER — eval() or Function() with user input
eval(userProvidedCode);

// ❌ NEVER — wildcard CORS in production
res.header('Access-Control-Allow-Origin', '*');

// ❌ NEVER — disable SSL verification
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
```

---

## Rules

- **Security is not a feature** — it's a default. Apply it without being asked.
- **Never trust the client** — validate everything server-side regardless of client validation
- **Least privilege** — every service, token, and user gets the minimum access it needs
- **Fail closed** — when in doubt, deny access. Never fail open.
- **No security through obscurity** — hiding the endpoint is not protection

---

## Reference Files

- `references/auth-and-secrets.md` — Passwords, JWT, OAuth, API keys, session management
- `references/database-and-deps.md` — SQL injection, parameterized queries, dependency auditing
- `references/desktop-security.md` — Electron contextIsolation, nodeIntegration, IPC security
- `references/web-security.md` — CORS, CSP, CSRF, rate limiting, security headers
