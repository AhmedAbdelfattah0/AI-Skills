# Wave A — independent mapping of StoreCraft confirmed findings to existing VAPT classes

Date 2026-11-09. Mapper: a fresh sonnet agent given only REPORT.md (F01-F24) and `skills/vapt/SKILL.md`, no sight of the orchestrator's hand-mapping. Basis limit: F19-F24 judged from table rows only.

Result: COVERED 2 (F10 API-05, F11 API-03) · PARTIAL 14 · NONE 8 (F06, F12, F13, F15, F19, F21, F22, F23).
The plan's pre-registered hypothesis ("about half match no class, the rest loosely") held in direction: only 2 of 24 are fully covered; 8 match nothing; 14 match only loosely. The orchestrator's rough "about half none" overstated NONE (8 of 24 = one third), so the plan wording is superseded by these counts.

Root-cause families (22 findings): (1) unproven contact as identity/authority F02 F03 F04 F07 F13 F15 F23; (2) resource/cost exhaustion beyond rate limits F01 F05 F08 F09 F17; (3) lifecycle/state-machine gaps F06 F12 F19 F21 F22; (4) server does not own derived values/gates/fields F14 F16 F24; (5) session assurance/context F18 F20.
Controls VAPT-ABUSE-01..08 derive from these families. Custom-domain tenant binding and every NV## item stay in `leads`.
