# docs-accuracy — Docstring / PHPDoc / JSDoc Rules (DOC-07)

In-code docs sit next to the truth — there is no excuse for drift. Adapted
from `amElnagdy/guard-skills` (MIT).

## The paraphrase test

**Delete any docstring whose entire information content is recoverable from
the signature.** "Gets the user by ID" above `get_user_by_id(id: str) -> User`
adds nothing — it is comment pollution wearing a suit (AI-generated docstrings
are systematically paraphrases).

## What a docstring earns its place with

Only what the types **cannot** express:

- Units and valid ranges ("timeout in *seconds*, must be > 0")
- Error behavior — what is raised/returned on failure, and when
- Side effects (writes a file, mutates the cache, sends an event)
- Null/None/undefined semantics beyond the type ("returns null only when the
  user was deleted, not when never-existed")
- Ordering, idempotency, concurrency guarantees
- The surprising *why* (a contract or workaround a maintainer must know)

## Tag accuracy (PHPDoc/JSDoc/etc.)

- `@param` names and types match the real signature, name-by-name
- `@return` matches the real return shape
- `@throws` lists errors the code actually raises — verify the raise sites
- `@since` / `@deprecated` verified against the changelog/tags

## Generated reference pages

If docstrings feed a generated docs site, a wrong docstring becomes a
published wrong reference page — treat tag accuracy at DOC-01 (must fix)
severity there.
