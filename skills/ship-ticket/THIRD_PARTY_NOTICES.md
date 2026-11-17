# Third-party notices

Material adapted into this skill from third-party sources. The full notice is also inline in every file
that carries the material (S-02-design §3).

## DeepSeek Harness (commit 39163dd)

| File in this skill | Upstream source | Use |
|---|---|---|
| `scripts/lib/git-exec.mjs` | `packages/experimental/worktree/src/index.ts:405-428` (`filterOverrides`), `:352-354` (`gitArgv`); `src/process.ts:23-28,156` (`GIT_ENV`, `spawnCommand` env) | adapted: `neutralisationPairs`, the BASE env and config pairs |
| `scripts/lib/git-exec.test.mjs` | `src/process.ts:23-28` (`GIT_ENV`); `tests/checkout-safety.spec.ts:25` (driver names) | hostile-env fixture and neutralisation cases |

```
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
