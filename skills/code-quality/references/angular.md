# Angular Best Practices Reference
> Covers: Angular 14–19, Signals (v17+), Standalone components (v15+)
>
> **Constitution-level summary only.** For *enforced* Angular review — the
> `NG-*` rule IDs, the Design Contract hard gate, and the evidence-backed
> Verification Pass — the **`angular-code-quality` skill is the source of
> truth**. Use this file to seed a `.code-quality.md` constitution; it must not
> contradict that skill. If the two ever differ, the skill wins.

## Architecture: MVVM + Signals

| Layer | Angular Construct | Rule |
|---|---|---|
| **Model** | `*.model.ts`, `*.interface.ts` | Data shape only — no logic, no methods |
| **ViewModel** | `*.service.ts` | Signals + computed + business logic + HTTP |
| **View** | `*.component.ts` + `.html` | Render only — binds to ViewModel via signals |

---

## Folder Structure (Feature-based)

```
src/app/
├── core/                 ← App-wide singletons (guards, interceptors, auth service)
├── features/
│   └── {feature}/
│       ├── components/   ← Dumb UI components (View)
│       ├── models/       ← Interfaces + types (Model)
│       ├── services/     ← State + business logic (ViewModel)
│       └── pages/        ← Routed shells
└── shared/               ← Reusable across features (components, pipes, services)
```

**Placement rules:**
- New component for a feature → `features/{feature}/components/`
- New routed page → `features/{feature}/pages/`
- State service → `features/{feature}/services/`
- Interface/type → `features/{feature}/models/`
- Used in 2+ features → `shared/`
- App-wide singleton → `core/services/`

---

## Signals Rules (Angular 17+)

```typescript
// ✅ Private writable, public readonly
private readonly _items = signal<Item[]>([]);
readonly items = this._items.asReadonly();

// ✅ Derived values → computed() in service, never getter in component
readonly count = computed(() => this._items().length);

// ✅ Side effects → effect() only
constructor() {
  effect(() => console.log('items changed:', this._items()));
}

// ✅ Convert Observable → Signal when needed
readonly user = toSignal(this.authService.user$);

// ❌ Never BehaviorSubject when signal works
// ❌ Never async pipe when signal is available
// ❌ Never subscribe() in components
// ❌ Never state signals defined in a component
```

---

## Component Rules

```typescript
@Component({
  standalone: true,                              // ✅ Always standalone
  changeDetection: ChangeDetectionStrategy.OnPush, // ✅ Always OnPush
  selector: 'app-{name}',                        // ✅ Consistent prefix
  templateUrl: './component.html',               // ✅ Separate files always
  styleUrl: './component.scss',
})
export class MyComponent {
  protected readonly state = inject(MyService);  // ✅ inject() not constructor
  // ❌ Never ngModel — use ReactiveFormsModule
  // ❌ Never `any` type
  // ❌ Never HttpClient injected here
  // ❌ Never console.log left in code
}
```

---

## Service (ViewModel) Rules

```typescript
@Injectable({ providedIn: 'root' })   // ✅ Singleton via providedIn
export class FeatureService {
  // ✅ One responsibility — don't mix state + generation + download
  // ✅ All HTTP calls live here, never in components
  // ✅ All business logic lives here, never in templates
}
```

---

## SOLID Quick Reference

- **S** — One service, one responsibility (state, generation, download = 3 services)
- **O** — New feature = new class, not editing existing logic
- **L** — Services implementing abstract base classes must honor all methods
- **I** — Small focused interfaces (`Nameable`, `Codeable`, not one giant interface)
- **D** — Depend on abstract classes/tokens, not concrete services directly

---

## Pre-Commit Self-Check

```
Architecture:
□ Every file in the correct folder per structure rules
□ No business logic inside components
□ No HttpClient injected directly in components
□ No state signals defined in components
□ All computed values are in services

Code Quality:
□ All signals exposed as readonly from services
□ All components are standalone + OnPush
□ Selector uses correct project prefix
□ No `any` types used
□ No console.log left in code

Signals:
□ No BehaviorSubject used where signal works
□ No async pipe where signal is available
□ No subscribe() in components

SOLID:
□ Each service has exactly one responsibility
□ Interfaces are small and focused
```

---

## Common Pitfalls

```typescript
// ❌ Logic in component template
{{ markets.filter(m => m.enabled).length }}  // → move to computed() in service

// ❌ State in component
export class MyComponent {
  items = signal<Item[]>([]);  // → belongs in service
}

// ❌ Multiple responsibilities in one service
class MyService {
  generate() {...}
  download() {...}
  validate() {...}  // → split into 3 services
}
```
