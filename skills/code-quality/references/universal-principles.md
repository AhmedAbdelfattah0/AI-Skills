# Universal Principles — Clean Code, SOLID, DRY, KISS, YAGNI

Language-agnostic rules that apply to **every** stack — including stacks with no
per-stack reference file (Go, Rust, Java, C#, …). Loaded always, alongside
`ai-failure-modes.md`: that file guards against the model's biases; this one is
the classic engineering layer. Adapted from `amElnagdy/guard-skills`
(clean-code-guard, MIT) and its primary sources (Martin, Fowler, Hunt & Thomas,
Metz, McCabe).

## Clean Code — names, functions, comments

1. **Names reveal intent.** Banned without a qualifier: `data`, `result`,
   `item`, `temp`, `value`, `obj`, `info`, `helper`, `manager`, `utils`,
   `handle_*`, `process_*`, `do_*`. A name answers *why it exists and what it
   does* (`raw_csv_bytes`, `parsed_invoice`). (Clean Code Ch. 2)
2. **Functions stay small and do one thing.** Target ≤20 lines, one level of
   abstraction; refactor ceiling ~50. If you can extract a sub-function whose
   name doesn't restate the body, the parent was doing two things. (Ch. 3)
3. **≤4 parameters.** At 5, introduce a request/config object. Never boolean
   flag arguments — split into two functions.
4. **Command/Query Separation.** A function either returns a value (query,
   noun-ish name) or has a side effect (command, verb name) — never both via
   output arguments.
5. **Comments explain *why*, never *what*.** Delete paraphrase comments,
   "Step N" scaffolding, and commented-out code. (Ch. 4)
6. **Match the neighbors.** Read the file + one neighbor before writing; mirror
   casing, imports, error handling, logging, client choices. Never introduce a
   second pattern for something the repo already does one way.

## SOLID — with the detection smells

| Principle | Rule | Smell that flags a violation |
|---|---|---|
| **S**RP | One actor per module — a class answers to one stakeholder group | Two unrelated subsystems both import/reach into the same class |
| **O**CP | Extend via new code, not edits | Adding a variant means another `type == "x"` branch in an existing function → refactor to registry/strategy/polymorphism first |
| **L**SP | No subclass refuses its parent's contract | An override that throws "unsupported", strengthens preconditions, or weakens postconditions → the inheritance is wrong |
| **I**SP | Small focused interfaces | Implementors stubbing out methods they don't need; "god" interfaces |
| **D**IP | Abstractions live with the client, not the implementation | An interface sitting next to its only concrete class in the implementation package |

## DRY — knowledge, not text

- **Definition (Hunt & Thomas, verbatim):** "Every piece of knowledge must have
  a single, unambiguous, authoritative representation within a system."
- **The misreading:** DRY ≠ "no duplicate code." Two functions that look alike
  but encode **different rules** are fine. One rule expressed in code + schema +
  docs is the violation.
- **Rule of 3:** don't extract on the first duplication, nor the second — by
  the third you know the real shape of the shared knowledge.
- **Metz corollary:** *"duplication is far cheaper than the wrong abstraction."*
  An abstraction that accumulated per-caller branches → re-inline into callers,
  delete dead branches, live with honest duplication, re-abstract only when the
  real shared knowledge is obvious.
- Can't *name* the knowledge a duplicated block represents? Leave the duplication.

## KISS — complexity ceilings

- **Cognitive Complexity ≤10 per function** (SonarSource; target <7 for new
  code) and **cyclomatic ≤10, nesting ≤5** (McCabe). Refactor before
  exceeding, not after.
- The two metrics answer different questions: cyclomatic = "how many paths —
  is this testable"; cognitive = "how hard is this for a human to follow".
  **When they disagree, prefer cognitive** — readability is the scarcer
  resource.
- The simplest design that passes today's tests wins. Cleverness that needs a
  comment to explain *how it works* (not why) is a smell.

## YAGNI — and where AI over-engineers

**Fowler's four costs of a presumptive feature:** build, delay (what you didn't
ship instead), carry (every future change is slower), repair (ripping it out).

**The ranked over-engineering list** — flag these on sight:

1. Interfaces/protocols with one implementation (inline until a second exists)
2. Factory classes wrapping trivial constructors
3. DI containers in small apps (explicit construction in `main()` is shorter)
4. Try/catch wrappers that change nothing
5. Config surface where most fields are never read; `enable_*` / `*_mode` flags with one code path
6. Plugin/registry scaffolding for two known cases (a conditional is clearer)
7. `utils` / `common` modules — magnets for unrelated functions
8. Re-implementing what the platform gives you — custom retries/enums/validation
   where stdlib, the type system, or a schema constraint already does it
   (flip side of ai-failure-modes #15: don't add a dependency for a few lines either)
9. Layering ceremony (Controller → Service → Manager → Repository) for CRUD
10. Pass-through adapters around a client you will never swap

**The one-question self-check:** for every parameter, class, file, abstraction —
*who calls this today?* "Nobody yet" = delete it.

## Sources

Robert C. Martin, *Clean Code* + "The Single Responsibility Principle" (2014) ·
Hunt & Thomas, *The Pragmatic Programmer* ("DRY") · Fowler, bliki "Yagni" +
*Refactoring* · Sandi Metz, "The Wrong Abstraction" (2016) · McCabe, "A
Complexity Measure" (1976) · G. Ann Campbell / SonarSource, "Cognitive
Complexity" (2018) · Meyer, CQS.
