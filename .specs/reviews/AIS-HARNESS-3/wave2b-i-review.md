# Wave 2b-i review (0c0a3f7), threat model: accidental/buggy workers only

Opus PASS (353/353, golden byte-identical, validate OK; no blocker/major). Codex PASS (no blocker/major). Includes the 2a known-limit fix.

Minors (not repaired, ship with follow-up):
1. engine-units.mjs:309 JSDoc says unit_clear_refused; code throws unit_clear_unauthorized (docs correct). Comment fix.
2. ceilingReached spends a re-check before the runner starts; a quiescence_unknown refusal burns allowance (low impact).
3. No test for "checks moved config.base" failure branch (engine-units.mjs:275-279).
4. Mutation detection covers ANY node's declared paths (including downstream), broader than the plan's "upstream": a check writing a later node's build output fails its unit. Documented. Owner note.
5. importInto dedupe keeps the existing record, so re-importing with a different --phase does not re-tag.
6. UNIT_CLEARED engine event omits the owner's reason (kept in state and RUN-STATE).
