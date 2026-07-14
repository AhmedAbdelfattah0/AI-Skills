# TypeScript Code Quality Reference

## Strict Mode (Non-Negotiable)
```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "exactOptionalPropertyTypes": true
  }
}
```

## Core Type Patterns

```typescript
// ✅ Explicit return types on all functions
function getUserById(id: string): Promise<User | null> { ... }

// ✅ Explicit interfaces for all data shapes
interface User {
  id: string;
  email: string;
  createdAt: Date;
}

// ✅ Union types over boolean flags
type Status = 'idle' | 'loading' | 'success' | 'error';

// ✅ Readonly for config / immutable data
interface Config {
  readonly apiUrl: string;
  readonly timeout: number;
}

// ✅ Generic response wrapper
interface ApiResponse<T> {
  data: T;
  error: string | null;
  status: number;
}

// ❌ Never use `any`
const data: any = response;  // BAD — use `unknown` then narrow

// ❌ Never non-null assertion without guard
user!.email  // BAD — use if (user) or optional chaining user?.email

// ❌ Never `object` or `Function` as types — type the signature
const handler: Function = ...  // BAD
```

## Type vs Interface Rule
```typescript
// Use interface for objects and classes (extensible)
interface UserRepository {
  findById(id: string): Promise<User | null>;
}

// Use type for unions, intersections, function signatures
type ID = string | number;
type UserWithRole = User & { role: Role };
type Handler = (req: Request, res: Response) => void;
```

## Error Handling
```typescript
// ✅ Custom error classes
class NotFoundError extends Error {
  constructor(resource: string, id: string) {
    super(`${resource} with id ${id} not found`);
    this.name = 'NotFoundError';
  }
}

// ✅ Never swallow errors silently
try {
  await doSomething();
} catch (error) {
  logger.error('Operation failed', { error });
  throw error;
}
```

## Naming Conventions
| Thing | Convention | Example |
|---|---|---|
| Interface | PascalCase | `UserProfile` |
| Type alias | PascalCase | `ApiResponse<T>` |
| Enum | PascalCase | `HttpStatus` |
| Enum value | SCREAMING_SNAKE | `HttpStatus.NOT_FOUND` |
| Function | camelCase | `getUserById` |
| Constant | SCREAMING_SNAKE | `MAX_RETRIES` |
| File | kebab-case | `user-repository.ts` |

## Self-Check
```
□ No `any` types anywhere (use `unknown` and narrow)
□ All functions have explicit return types
□ strict: true in tsconfig.json
□ No non-null assertions (!) without null guards
□ Interfaces for objects, types for unions/functions
□ Error types are specific (not just `Error`)
```
