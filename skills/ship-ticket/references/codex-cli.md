# Talking to Codex — one CLI contract, two touchpoints

Codex is asked twice, for different things, through different carriers. **What
the CLI does is identical; what happens on failure is not.** Keep both halves.

Codex is always a **contributor, never an approver**. It critiques the plan and
the diff; it never approves either, and its absence degrades the review loudly
rather than stopping the run.

## The CLI contract — verified on `codex-cli 0.145.0`

Re-check `codex review --help` if the installed version differs.

- **`codex review` takes a scope flag OR a custom prompt, never both.**
  `--uncommitted`, `--base` and `--commit` each conflict with `[PROMPT]`, the `-`
  stdin form included, and the command exits during argument parsing without
  reviewing anything. So a pass is either *instructed* (bare prompt, scope stated
  in the prompt text) or *scoped* (`--base`, no instructions, findings arriving as
  `[P1]`/`[P2]` prose with no quoted line).
- **`codex exec` takes `-s` / `--sandbox read-only`.** There is no `--read-only`
  on `codex exec` — that is the `codex-delegate` relay's own flag.
- **The read-only sandbox does not confine *reads* to the `--cd` subtree.** A run
  rooted in one repo read a sibling repo by absolute path. `--cd` exists to give
  git a valid repository, not to scope what may be read.
- **`--cd` must be a git repository.** A directory that merely *holds* two repos
  is not one, and Codex refuses in under a second.
- **The final report prints twice.** Deduplicate it.
- **Paths come back absolute.** Strip the prefix before anything is posted.

### Always set the effort explicitly

```bash
codex review -c model_reasoning_effort=high "<instructions>"
```

Many accounts set `model_reasoning_effort = "xhigh"` globally in
`~/.codex/config.toml`. **Inheriting that is what blows a dispatch's watchdog.**
Measured on this repo, same diff, same prompt: `codex review` instructed at
`xhigh` **384s**; the same work at `medium` via the relay **177s** — 2.2x, with no
change to what was asked.

**Pin it at `high`, constantly. Do not scale it by ticket size.** With a
probabilistic reviewer a lower effort on the same prompt is a lower detection
rate, not merely a shorter wait. The fix for the watchdog is pinning the value,
never lowering it per ticket.

### Bound the ask, not just the wait

An unbounded "report everything" over a large tree at high effort is what produces
40-minute passes. Demand findings **severity-ordered, blockers and majors first**,
say plainly that minors may be truncated, and cap the total. A reviewer that
spends its budget on nits has spent it in the wrong place.

## Touchpoint 1 — the plan critique

Needs **both** `codex-delegate` *and* the `codex` binary, because it dispatches
through the relay. Invoke the skill **by name** — it supplies its own relay path,
and it installs to `~/.agents/skills`, not beside this repo's skills, so the
`../<sibling>/` convention does not resolve for it.

A plan reviewed by the model that wrote it inherits that model's blind spots, and
the expensive failures — a sequence that cannot build in that order, a path that
does not exist, a module that already does the thing — are cheap to catch here and
expensive to catch mid-build.

**Run the deterministic pre-checks first; they are free.** Verify mechanically
that every path exists or is explicitly new, every command exists in the repo's
own config, the sequence is acyclic with each step's dependencies landing before
it, and no existing implementation of this already exists. Findings go straight
into the draft. **Send their results as *given*, with an instruction not to
re-verify them** — re-reading the tree to confirm what `test -e` already proved is
the single biggest avoidable cost here.

**Dispatch only a semantically complete plan.** Codex receives the draft verbatim
and the user approves the *reconciled* plan, so sending an unfinished draft to
start the clock earlier reviews the wrong object. Sections 1–6 are finished first.
While it runs, prepare only derivative read-only material — the rule-surface
matrix, the approval summary, the command inventory, the degradation report. Do
not implement, do not finalize the contract, do not change the plan underneath it.

**Read-only always**, and nothing lands in the repo: pipe the brief in on stdin
and leave the relay's `--out-dir` at its default temp dir, so plan mode's clean
tree survives the round trip.

**The brief carries:**

| Block | Contents |
|---|---|
| `<task>` | the ticket's spec and ACs, the **drafted plan verbatim**, the detected stack, the repo's **real** commands, and the pre-check results as given |
| `<grounding_rules>` | every claim cites a path or line from this repo; label inferences; read the files the plan names before judging them |
| `<structured_output_contract>` | findings severity-ordered, blockers first, minors truncatable, capped: severity · the plan section hit · `file:line` evidence · the concrete change proposed. Then one line: is this plan buildable as sequenced? |

**Ask only what a repo-grounded second model can answer** — the pre-checks already
covered path existence and duplicate implementation:

1. Is the build sequence buildable in that order — does step *n* depend on
   something step *n+2* creates?
2. What is missing that the ticket's ACs require?
3. What in the risks section is wrong, and what risk is absent?

**Size the watchdog to the read, not to a number.** `--timeout 15m` suits one repo
of ordinary size. What drives duration is the volume Codex must read and reason
over. Treat **+10m per additional repository as a conservative floor**, then raise
it for a large tree. A watchdog shorter than the read guarantees a timeout and
buys nothing.

**Multi-repo tickets:** root the dispatch **inside one repo** — the one the plan
changes most — and give the other's **absolute path** in the brief with a line
saying Codex may read there. Say which repo is the root so relative paths in its
findings are unambiguous.

### A watchdog expiry is not a total loss

The watchdog kills the live **process**, not the persisted **session**, so what
Codex already read is still reachable. **Resume it** with a short delta brief
asking for its findings from what it has already read, bounded and
severity-ordered.

Three conditions make that safe rather than a second failure:

- **A non-empty `threadId` must exist** in the timed-out `result.json`. No thread
  id, no recovery.
- **Reuse the original `--cd`, `--read-only` and explicit effort.** A resume that
  re-derives them can repeat the not-a-git-repo failure, silently inherit a
  write-capable sandbox, or fall back to the account's global effort — which
  caused the timeout in the first place.
- **Bound the recovery** with its own short timeout. An unbounded "just finish up"
  is the same failure with a longer fuse.

**Only when there is no `threadId`, the resume is rejected or exits non-zero, or
the bounded recovery itself times out** is the critique unavailable — then declare
the degradation. A watchdog expiry *alone*, with a resumable session, is a
recoverable event, not a missing companion.

Read `finalMessage` from `result.json`; record `threadId` — it identifies the
session for a follow-up and is the audit trail if this route signs later.

### Reconcile — your judgment, not Codex's

Every finding is **incorporated into the draft** or **rejected with a stated
reason**, and both get a row in section 7. Plan findings carry no rule IDs, so
*the stated reason is the citation*. A rejected blocker needs a reason a reader
can check, not "considered and dismissed".

Never present Codex's agreement as approval, never skip the approval flow because
the critique came back clean, and never let a Codex objection alone kill a plan
the ticket requires — surface the disagreement and let the user decide. If the
critique changes the approach materially, **redraft before presenting**: the user
approves the reconciled plan, not the draft plus a list of things you would change.

## Touchpoint 2 — pass B, the diff review

Needs **only the `codex` binary**. A missing `codex-delegate` costs the plan
critique and leaves this intact — never disable both because one is absent.

Run it from the repo root **in the background, concurrently with the other passes**.
It is routinely the longest, so it starts at the freeze, not after the others.

**`codex exec -s read-only` is the preferred carrier** — measured ~1.3x faster
than `codex review` on identical input (289s vs 384s), because you hand it the
diff instead of having it rediscover the scope. `codex review` remains valid.
Either is acceptable; what is not acceptable is inheriting the global effort.

**Give it the retrieval recipe, not just a file list.** A list of paths and
digests does not tell a reviewer how to *see* the change. Hand over the exact
tracked-diff command from the merge-base through the final working tree — covering
committed, staged and unstaged layers — plus instructions to read every
**untracked** file in full, plus the manifest's per-path stage metadata so
deletions and renames are visible as such. The normal path is uncommitted work,
and a bare `git diff` hides staged changes.

Give it the ticket's ACs, the plan's *Not in this ticket* list, and a demand for
`file:line` + quoted code + fix shape. Let it use its own judgment about what to
look for — it does not need to re-run the rule catalogue; that is pass C's job.

**Bound its wait. Default ceiling: 15 minutes**, overridable by the repo or the
user — record which applied *before* dispatching. On timeout, declare the
degradation exactly like a missing engine and fall back to
`/coderabbit:code-review` on the same manifest. **A declared timeout that falls
back is a degradation, not a stop** — it is a review engine failing over, not a
review step failing.

Never let an unbounded external wait silently become the run's critical path.

## PR-side bots are not a gate

Once the PR is open, CodeRabbit's GitHub app and any Codex cloud review wired to
the repo may re-review the same diff. Read them only if they have already posted.
Never wait on one.
