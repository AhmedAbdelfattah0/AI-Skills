# React Best Practices Reference
> Covers: React 18/19, Next.js 13+, TypeScript, hooks-first

## Architecture: Component + Custom Hooks

| Layer | React Construct | Rule |
|---|---|---|
| **Data/Logic** | Custom hooks (`use*.ts`) | State, business logic, API calls |
| **UI** | Components (`*.tsx`) | Render only — consumes hooks |
| **Types** | `*.types.ts` | Interfaces and types, no logic |
| **Services** | `*.service.ts` / `api/*.ts` | Raw API calls, no UI concerns |

---

## Folder Structure

```
src/
├── app/               ← Next.js app router (or pages/)
├── components/
│   ├── ui/            ← Generic reusable (Button, Input, Card)
│   └── {feature}/     ← Feature-specific components
├── hooks/             ← Shared custom hooks
├── features/
│   └── {feature}/
│       ├── components/ ← Feature components
│       ├── hooks/      ← Feature-specific hooks
│       ├── types/      ← Feature types
│       └── api/        ← Feature API calls
├── lib/               ← Third-party config (supabase, prisma, etc.)
├── types/             ← Global shared types
└── utils/             ← Pure utility functions
```

---

## Custom Hooks — Logic Goes Here

```typescript
// ✅ State + business logic in custom hook
export function useProductList() {
  const [items, setItems] = useState<Product[]>([]);
  const [loading, setLoading] = useState(false);

  const loadItems = useCallback(async () => {
    setLoading(true);
    const data = await productApi.getAll();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => { loadItems(); }, [loadItems]);

  return { items, loading, reload: loadItems };
}

// ✅ Component consumes hook — pure rendering
export function ProductList() {
  const { items, loading } = useProductList();

  if (loading) return <Spinner />;
  return <ul>{items.map(item => <ProductCard key={item.id} item={item} />)}</ul>;
}
```

---

## Component Rules

```typescript
// ✅ Function components only (never class components)
// ✅ Props interface always defined
interface ButtonProps {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'ghost' | 'danger';
}

// ✅ Destructure props
export function Button({ label, onClick, variant = 'primary' }: ButtonProps) {
  return <button className={styles[variant]} onClick={onClick}>{label}</button>;
}

// ❌ Never fetch data directly in component body
// ❌ Never mutate props
// ❌ Never use index as key for dynamic lists
// ❌ Never `any` type
```

---

## State Management Rules

```typescript
// Local UI state → useState
const [isOpen, setIsOpen] = useState(false);

// Derived values → useMemo (not state)
const total = useMemo(() => items.reduce((s, i) => s + i.price, 0), [items]);

// Cross-component state → Context or Zustand/Jotai (not prop-drilling 3+ levels)
// Server state → TanStack Query (not manual useEffect + useState)
// Form state → React Hook Form (not manual controlled inputs)

// ❌ Never useEffect to sync state with state (use derived values)
// ❌ Never setState in useEffect without dependency array justification
```

---

## Next.js Specific (App Router)

```typescript
// ✅ Server components by default — add 'use client' only when needed
// ✅ Fetch in server components, pass data as props
// ✅ Loading/error boundaries per route segment
// ✅ Server actions for mutations (not API routes for simple CRUD)
// ❌ Never fetch in client components when server component works
// ❌ Never expose env secrets in client components
```

---

## Pre-Commit Self-Check

```
Architecture:
□ No fetch/API calls directly in component body
□ Business logic extracted to custom hooks
□ Types defined for all props and return values

Code Quality:
□ No `any` types
□ No console.log left in code
□ No class components
□ Props always typed with interface
□ No index used as key for dynamic lists

State:
□ No useEffect to sync state-with-state (use useMemo)
□ Server state managed via TanStack Query or SWR, not manual
□ No prop-drilling beyond 2 levels (use Context or state lib)

Next.js:
□ Components are Server Components unless they need interactivity
□ No secrets in client-side code
```
