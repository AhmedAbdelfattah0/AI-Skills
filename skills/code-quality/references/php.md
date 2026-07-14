# PHP Best Practices Reference
> Covers: PHP 8.0+, Laravel 10/11, Slim, vanilla PHP (PSR standards)
> ⚠️ Always audit before changing unfamiliar PHP code — see audit rules below.

## Architecture: MVC (Laravel) / PSR Layered (vanilla/Slim)

| Layer | PHP Construct | Rule |
|---|---|---|
| **Route** | `routes/web.php`, `routes/api.php` | Routing only — no logic |
| **Controller** | `app/Http/Controllers/` | Input validation → service call → response |
| **Service** | `app/Services/` | Business logic, orchestration |
| **Repository** | `app/Repositories/` | DB queries only |
| **Model** | `app/Models/` | Eloquent model + relationships + casts |
| **Request** | `app/Http/Requests/` | FormRequest validation rules |

---

## Folder Structure (Laravel)

```
app/
├── Http/
│   ├── Controllers/      ← Thin controllers, no business logic
│   ├── Middleware/        ← Auth, CORS, throttle
│   └── Requests/          ← Form request validation
├── Models/               ← Eloquent models
├── Services/             ← Business logic layer
├── Repositories/         ← DB query layer (optional but preferred)
├── Exceptions/           ← Custom exception classes
└── Providers/            ← Service container bindings
```

---

## Audit-First Rule

⚠️ For unfamiliar PHP codebases, ALWAYS audit before making changes:

```bash
echo "=== PHP AUDIT SIGNALS ===" && \
# Check PHP version
php --version 2>/dev/null && \
cat composer.json | grep '"php"' 2>/dev/null && \

# Check for common vulnerability patterns
grep -rn "mysqli_query\|mysql_query\|\$_GET\|\$_POST\|\$_REQUEST" --include="*.php" . 2>/dev/null | grep -v vendor | head -20 && \
grep -rn "eval(\|exec(\|system(\|passthru(\|shell_exec(" --include="*.php" . 2>/dev/null | grep -v vendor | head -10 && \

# Check if using prepared statements
grep -rn "prepare\|PDO\|Eloquent\|DB::select" --include="*.php" . 2>/dev/null | grep -v vendor | head -10
```

Do NOT change business logic until you understand the current behavior.

---

## PHP 8 Patterns

```php
// ✅ Type declarations everywhere
function createProduct(string $name, int $price, ?string $category = null): Product

// ✅ Named arguments for clarity
$product = new Product(name: 'Chair', price: 299, category: 'furniture');

// ✅ Match expression over switch
$label = match($status) {
    'active'  => 'Active',
    'pending' => 'Pending Review',
    'deleted' => 'Removed',
    default   => throw new InvalidArgumentException("Unknown status: $status"),
};

// ✅ Constructor property promotion
class Product {
    public function __construct(
        private readonly string $name,
        private readonly int $price,
    ) {}
}

// ❌ Never raw $_GET/$_POST without sanitization
// ❌ Never string interpolation in SQL queries
// ❌ Never suppress errors with @
```

---

## Laravel Specific

```php
// ✅ FormRequest for all input validation
class CreateProductRequest extends FormRequest {
    public function rules(): array {
        return [
            'name'  => ['required', 'string', 'max:255'],
            'price' => ['required', 'integer', 'min:0'],
        ];
    }
}

// ✅ Thin controller — validate, call service, return
class ProductController extends Controller {
    public function store(CreateProductRequest $request): JsonResponse {
        $product = $this->productService->create($request->validated());
        return response()->json(['data' => $product], 201);
    }
}

// ✅ Eloquent: define casts, relationships, scopes
class Product extends Model {
    protected $casts = ['price' => 'integer', 'active' => 'boolean'];
    public function category(): BelongsTo { return $this->belongsTo(Category::class); }
    public function scopeActive(Builder $query): void { $query->where('active', true); }
}

// ❌ Never business logic in controllers
// ❌ Never DB queries in controllers (use service/repo)
// ❌ Never trust $request->all() — always use validated()
```

---

## Security Rules (PHP)

```php
// ✅ Always use prepared statements
$stmt = $pdo->prepare('SELECT * FROM products WHERE id = ?');
$stmt->execute([$id]);

// ✅ Sanitize output (XSS prevention)
echo htmlspecialchars($userInput, ENT_QUOTES, 'UTF-8');

// ✅ Hash passwords — never MD5/SHA1
password_hash($password, PASSWORD_BCRYPT);
password_verify($input, $hash);

// ✅ Validate file uploads strictly
$allowed = ['image/jpeg', 'image/png', 'image/webp'];
if (!in_array($_FILES['file']['type'], $allowed)) { abort(422); }

// ❌ Never eval() with user data
// ❌ Never include/require from user input
// ❌ Never store plaintext passwords
// ❌ Never expose error details in production
```

---

## Pre-Commit Self-Check

```
Architecture:
□ No business logic in controllers
□ No DB queries in controllers
□ Input validated via FormRequest (Laravel) or equivalent
□ Models use $casts for type safety

Security:
□ No raw SQL string interpolation
□ All user input sanitized before output (htmlspecialchars)
□ Passwords hashed with bcrypt/argon2 (never MD5/SHA1)
□ File uploads validated by type and size
□ No eval() with user-provided data

Code Quality:
□ PHP 8 type declarations on all functions
□ No @ error suppression
□ No raw $_GET/$_POST (use validated input)
□ Errors not exposed in production (APP_DEBUG=false)
```
