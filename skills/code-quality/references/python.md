# Python Best Practices Reference
> Covers: Python 3.10+, Django, FastAPI, Flask, type hints

## Architecture

| Framework | Pattern |
|---|---|
| **FastAPI** | Router → Endpoint → Service → Repository → Schema |
| **Django** | URL → View → Service → Model → Serializer |
| **Flask** | Blueprint → View → Service → Model |

---

## Folder Structure (FastAPI)

```
app/
├── api/
│   └── v1/
│       ├── routers/     ← Route definitions per domain
│       └── deps.py      ← Shared dependencies (auth, db session)
├── core/
│   ├── config.py        ← Settings with pydantic-settings
│   └── security.py      ← Auth helpers
├── models/              ← SQLAlchemy ORM models
├── schemas/             ← Pydantic schemas (input/output)
├── services/            ← Business logic layer
├── repositories/        ← DB query layer
└── main.py              ← App factory
```

---

## Type Hints — Always Required

```python
# ✅ All function signatures typed
def create_product(name: str, price: int, category_id: int | None = None) -> Product:
    ...

# ✅ Pydantic schemas for input/output (FastAPI)
class ProductCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    price: int = Field(..., ge=0)
    category_id: int | None = None

class ProductResponse(BaseModel):
    id: int
    name: str
    price: int

    class Config:
        from_attributes = True  # Pydantic v2

# ❌ Never use Any type hint unless genuinely unavoidable
# ❌ Never skip return type annotations
```

---

## FastAPI Patterns

```python
# ✅ Thin router — dependency injection for auth and db
@router.post("/products", response_model=ProductResponse, status_code=201)
async def create_product(
    data: ProductCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_auth),
) -> ProductResponse:
    return await product_service.create(db, data, user.id)

# ✅ Service layer owns business logic
class ProductService:
    async def create(self, db: AsyncSession, data: ProductCreate, user_id: int) -> Product:
        existing = await self.repo.find_by_name(db, data.name, user_id)
        if existing:
            raise HTTPException(409, "Product name already exists")
        return await self.repo.create(db, {**data.model_dump(), "user_id": user_id})

# ✅ Repository layer owns DB queries
class ProductRepository:
    async def find_by_name(self, db: AsyncSession, name: str, user_id: int) -> Product | None:
        result = await db.execute(
            select(Product).where(Product.name == name, Product.user_id == user_id)
        )
        return result.scalar_one_or_none()

# ❌ Never DB queries in route handlers
# ❌ Never business logic in route handlers
```

---

## Django Patterns

```python
# ✅ Use class-based views or DRF ViewSets
class ProductViewSet(ModelViewSet):
    serializer_class = ProductSerializer
    permission_classes = [IsAuthenticated]
    queryset = Product.objects.none()  # Override in get_queryset

    def get_queryset(self):
        return Product.objects.filter(user=self.request.user)

    def perform_create(self, serializer):
        serializer.save(user=self.request.user)  # ✅ Always assign owner

# ✅ DRF Serializers validate input
class ProductSerializer(serializers.ModelSerializer):
    class Meta:
        model = Product
        fields = ['id', 'name', 'price']
        read_only_fields = ['id']

# ❌ Never trust request.data without serializer validation
# ❌ Never expose sensitive fields (passwords, tokens) in serializers
```

---

## Security Rules

```python
# ✅ Settings via environment
from pydantic_settings import BaseSettings
class Settings(BaseSettings):
    DATABASE_URL: str
    SECRET_KEY: str
    DEBUG: bool = False

    class Config:
        env_file = ".env"

# ✅ Parameterized queries (never f-strings in SQL)
await db.execute(select(User).where(User.email == email))  # ORM = safe
# NEVER: f"SELECT * FROM users WHERE email = '{email}'"

# ✅ Secrets via environment, never hardcoded
# ✅ DEBUG=False in production
# ❌ Never print() secrets or passwords
```

---

## Pre-Commit Self-Check

```
Architecture:
□ Business logic in service layer, not in routes/views
□ DB queries in repository layer, not in services or routes
□ Pydantic schemas used for all input/output (FastAPI)
□ Django serializers used for all input validation

Type Safety:
□ All function signatures have type hints
□ No bare `Any` type hints
□ Return types annotated on all functions

Security:
□ No hardcoded secrets — all from environment
□ No f-strings or % formatting in SQL queries
□ DEBUG=False in production config
□ Sensitive fields excluded from serializers/schemas

Code Quality:
□ No print() for logging (use logging module)
□ Async functions used consistently (don't mix sync/async DB calls)
□ No bare except clauses (always catch specific exception types)
```
