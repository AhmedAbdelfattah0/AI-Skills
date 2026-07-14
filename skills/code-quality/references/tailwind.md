# Tailwind CSS Code Quality Reference
> Covers: Tailwind CSS v3/v4

## Core Rules

```html
<!-- ✅ Use design tokens — never magic numbers -->
<div class="p-4 gap-6 text-sm font-medium">   <!-- stick to Tailwind scale -->

<!-- ✅ Mobile-first responsive -->
<div class="flex-col md:flex-row lg:grid lg:grid-cols-3">

<!-- ✅ State variants -->
<button class="bg-primary hover:bg-primary/90 focus:ring-2 focus:ring-primary/50 disabled:opacity-50">

<!-- ❌ Never arbitrary values unless truly unavoidable -->
<div class="w-[347px]">   <!-- BAD — use w-80 or w-96 -->

<!-- ❌ Never inline styles -->
<div style="margin-top: 16px">   <!-- BAD — use mt-4 -->

<!-- ❌ Never override Tailwind with custom CSS unless no utility exists -->
```

## Color System Convention

Define semantic color tokens in your config, then use them:

```css
/* tailwind.config — define semantic tokens */
colors: {
  primary: 'your-brand-color',
  surface: 'your-surface-color',
  muted: 'your-muted-color',
}

/* Then use consistently */
.bg-primary, .text-primary, .border-primary
.bg-surface, .text-muted
```

## Component Class Extraction

Only extract when a pattern repeats 3+ times:

```typescript
// ✅ cva() for variant components (class-variance-authority)
const buttonVariants = cva(
  'inline-flex items-center justify-center rounded font-medium transition-colors',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-white hover:bg-primary/90',
        ghost: 'bg-transparent border border-primary text-primary',
        danger: 'bg-red-600 text-white hover:bg-red-700',
      },
      size: {
        sm: 'h-8 px-3 text-sm',
        md: 'h-10 px-4',
        lg: 'h-12 px-6 text-lg',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  }
);

// ❌ Don't @apply for one-off styling — just write the classes inline
```

## Tailwind v4 Specifics

```css
/* v4: Use CSS custom properties instead of tailwind.config.js */
@theme {
  --color-primary: oklch(0.5 0.2 250);
  --spacing-section: 4rem;
  --font-heading: 'Inter', sans-serif;
}

/* Then use as utilities automatically */
/* bg-primary, text-primary, font-heading, p-section */
```

## RTL Support (if required)

```html
<!-- ✅ Use logical properties for RTL-compatible layouts -->
<div class="ms-4 me-4 ps-6 pe-6">   <!-- margin/padding start/end -->
<div class="text-start">             <!-- not text-left -->
<div class="border-s-2">            <!-- border on logical start side -->

<!-- ❌ Avoid directional utilities when RTL is needed -->
<div class="ml-4 mr-4 pl-6 text-left">   <!-- breaks in RTL -->
```

## Spacing Scale Reference
```
1 = 4px   2 = 8px   3 = 12px  4 = 16px
5 = 20px  6 = 24px  8 = 32px  10 = 40px
12 = 48px 16 = 64px 20 = 80px 24 = 96px
```

## Self-Check
```
□ No arbitrary values like w-[347px] (unless truly unique)
□ No inline styles
□ Mobile-first (default → md: → lg:)
□ Semantic color tokens used (not raw hex/rgb)
□ Logical properties used if RTL support is required
□ Repeated patterns extracted with cva() or @apply (3+ occurrences)
□ No custom CSS that duplicates existing Tailwind utilities
```
