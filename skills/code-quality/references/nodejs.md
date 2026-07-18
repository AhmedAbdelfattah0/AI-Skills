# Node.js Best Practices Reference
> Covers: Express, NestJS, Fastify — TypeScript preferred
>
> **Constitution-level summary only.** For *enforced* backend review — the
> `BE-*` rule IDs, security tiers, tenant isolation, and the Verification Pass —
> the **`backend-code-quality` skill is the source of truth** (stack-agnostic,
> not just Node). Use this file to seed a `.code-quality.md` constitution; it
> must not contradict that skill. If the two ever differ, the skill wins.

## Architecture: Layered (Router → Controller → Service → Repository)

| Layer | File Pattern | Rule |
|---|---|---|
| **Router** | `*.routes.ts` | Route definitions + middleware wiring only |
| **Controller** | `*.controller.ts` | Parse request → call service → send response |
| **Service** | `*.service.ts` | Business logic, orchestration, validation |
| **Repository** | `*.repository.ts` | Database queries only, no business logic |
| **Model/DTO** | `*.dto.ts`, `*.model.ts` | Data shapes and validation schemas |

---

## Folder Structure

```
src/
├── config/              ← App config, env validation
├── middleware/          ← Auth, logging, error handler, rate limiter
├── modules/ (or features/)
│   └── {domain}/
│       ├── {domain}.routes.ts
│       ├── {domain}.controller.ts
│       ├── {domain}.service.ts
│       ├── {domain}.repository.ts
│       └── {domain}.dto.ts
├── shared/
│   ├── errors/          ← Custom error classes
│   ├── utils/           ← Pure helpers
│   └── types/           ← Global types
├── database/            ← DB connection, migrations
└── app.ts               ← Express/Fastify app factory (no routes here)
```

---

## Express Patterns

```typescript
// ✅ Route: thin, just wiring
router.post('/products', authenticate, validate(CreateProductDto), productController.create);

// ✅ Controller: parse → delegate → respond
export class ProductController {
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const product = await this.productService.create(req.body, req.user!.id);
      res.status(201).json({ data: product });
    } catch (err) {
      next(err);  // ✅ Always delegate errors to error middleware
    }
  }
}

// ✅ Service: pure business logic
export class ProductService {
  async create(dto: CreateProductDto, userId: string): Promise<Product> {
    const existing = await this.productRepo.findByName(dto.name, userId);
    if (existing) throw new ConflictError('Product name already exists');
    return this.productRepo.create({ ...dto, userId });
  }
}

// ✅ Repository: DB only
export class ProductRepository {
  async findByName(name: string, userId: string) {
    return db.product.findFirst({ where: { name, userId } });
  }
}

// ❌ Never query DB directly in controller
// ❌ Never put business logic in routes
// ❌ Never swallow errors (always next(err) or throw)
```

---

## Environment & Security Rules

```typescript
// ✅ Validate env at startup — fail fast
import { z } from 'zod';
const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  PORT: z.coerce.number().default(3000),
});
export const env = envSchema.parse(process.env);

// ✅ Never hardcode secrets
// ✅ Never log full request bodies (may contain passwords)
// ✅ Use parameterized queries always (no string interpolation in SQL)
// ✅ Rate-limit all public endpoints
// ✅ Sanitize all user input before DB operations
```

---

## Error Handling

```typescript
// ✅ Custom error classes
export class AppError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}
export class NotFoundError extends AppError {
  constructor(resource: string) { super(404, `${resource} not found`); }
}
export class ConflictError extends AppError {
  constructor(msg: string) { super(409, msg); }
}

// ✅ Central error middleware (last middleware registered)
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});
```

---

## Pre-Commit Self-Check

```
Architecture:
□ No DB queries in controllers
□ No business logic in routes
□ No HTTP logic (req/res) in services
□ Repository layer used for all DB access

Security:
□ All env vars validated at startup with zod/joi
□ No hardcoded secrets or tokens
□ All public endpoints rate-limited
□ Parameterized queries only (no SQL interpolation)
□ Input sanitized before DB operations

Error Handling:
□ All async route handlers use try/catch + next(err)
□ Custom error classes used for predictable errors
□ Central error middleware registered last
□ No sensitive data in error responses

Code Quality:
□ TypeScript strict mode enabled
□ No `any` types
□ No console.log left (use a logger like pino/winston)
```
