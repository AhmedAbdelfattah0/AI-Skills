# Vue Best Practices Reference
> Covers: Vue 3, Composition API, Pinia, Nuxt 3

## Architecture: Composition API + Pinia

| Layer | Vue Construct | Rule |
|---|---|---|
| **State** | Pinia store (`*.store.ts`) | Global/shared state and actions |
| **Logic** | Composables (`use*.ts`) | Reusable reactive logic |
| **UI** | Single-file components (`.vue`) | Template + scoped styles |
| **Types** | `*.types.ts` | Interfaces and types only |

---

## Folder Structure

```
src/
├── assets/
├── components/
│   ├── ui/             ← Generic reusable components
│   └── {feature}/      ← Feature-specific components
├── composables/        ← Shared composables (useAuth, useTheme)
├── pages/ (or views/)  ← Route-level components
├── router/
├── stores/             ← Pinia stores per domain
├── types/              ← Global types
└── utils/              ← Pure functions
```

For Nuxt 3:
```
├── components/         ← Auto-imported
├── composables/        ← Auto-imported
├── pages/              ← File-based routing
├── server/api/         ← Server routes
└── stores/             ← Pinia stores
```

---

## Composition API Rules

```typescript
// ✅ Always <script setup> syntax
<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'

const count = ref(0)
const doubled = computed(() => count.value * 2)  // ✅ Derived → computed
</script>

// ✅ Composable for reusable logic
export function useCounter(initial = 0) {
  const count = ref(initial)
  const increment = () => count.value++
  const reset = () => count.value = initial
  return { count: readonly(count), increment, reset }  // ✅ Expose readonly
}

// ❌ Never Options API for new code
// ❌ Never mutate props directly
// ❌ Never skip TypeScript generics on refs
```

---

## Pinia Store Rules

```typescript
// ✅ Setup store syntax (preferred)
export const useProductStore = defineStore('product', () => {
  const items = ref<Product[]>([])
  const loading = ref(false)

  const total = computed(() => items.value.length)  // ✅ Getters = computed

  async function fetchAll() {  // ✅ Actions = plain functions
    loading.value = true
    items.value = await productApi.getAll()
    loading.value = false
  }

  return { items: readonly(items), loading: readonly(loading), total, fetchAll }
})

// ❌ Never mutate store state directly from components (use actions)
// ❌ Never put API calls directly in components that have a store
```

---

## Component Rules

```typescript
// ✅ Define props with TypeScript
const props = defineProps<{
  title: string
  items: Item[]
  variant?: 'default' | 'compact'
}>()

// ✅ Define emits with TypeScript
const emit = defineEmits<{
  select: [item: Item]
  close: []
}>()

// ✅ Use v-model properly with defineModel (Vue 3.4+)
const model = defineModel<string>()

// ❌ No business logic in template expressions
// ❌ No direct store mutations from templates
// ❌ Never use `any`
```

---

## Pre-Commit Self-Check

```
Architecture:
□ All components use <script setup lang="ts">
□ Business logic in composables or Pinia stores, not in components
□ No API calls directly in component setup

Code Quality:
□ Props typed with TypeScript generics
□ Emits typed with TypeScript
□ No `any` types
□ No console.log left in code
□ Reactive refs exposed as readonly from composables/stores

State:
□ Shared state managed via Pinia (not prop-drilling)
□ No direct store state mutation from components
□ Derived values use computed(), not watched state
```
