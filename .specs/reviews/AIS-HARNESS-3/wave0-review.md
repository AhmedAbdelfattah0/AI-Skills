# Wave 0 review (commit 8d8f333), one execution, threat model: accidental/buggy workers only

- Opus primary: PASS. 316/316 tests, wave0 file 27/27 twice, validate OK. No in-scope blocker/major.
- Codex second opinion: PASS. No in-scope findings; carrier split byte-identical. Launcher/process-group and Windows skips inspected, not executed (read-only run); covered by the full suite run on POSIX.
- Orchestrator re-ran: 316/316, validate OK.

Minors (ship with follow-up, per ship threshold; not repaired in this round):
1. engine-quiesce.mjs:33-36/:67: a recycled leader pid with a different start time returns `unknown` forever (safe failure, low likelihood). Fix: mark `quiesced` without signalling.
2. run-state.mjs:26 eventLine does not escape `<`; an owner reason containing the END marker text makes the plan malformed (fails closed).
3. engine-gates.mjs:273-275 refreshRed counts a transient `candidate_unavailable` as the one allowed re-run.
4. B4 rejection reasoning only half holds (moved base does not flag the ownership breach).
5. carrier export list gained `gitDirty`.
Owner decisions pending from the CodeRabbit table: I12 (RED/proof runners get unstripped env), B12 (32 MiB stdout truncation), I7 (imported usage has no phase).
