/**
 * Policy-version pinning, minimum (S-27-min, ASTF-21). Node built-ins only; a leaf module (the
 * carrier imports it too).
 *
 * A run records at `init` the policy version of the engine that started it (`policy_version`) and
 * the commit of the skill checkout that engine ran from (`skill_commit`). Every later command
 * resolves the semantics of the RUN's version through policySemantics(), never the newest the
 * installed engine knows, and refuses a version it does not support (`policy_version_unsupported`,
 * fail closed). A state without the key predates it and is version 1, today's semantics.
 *
 * This is NOT executable pinning: the scripts run from disk as installed. A future slice that
 * changes semantics must add a version here AND keep the old version's code path reachable through
 * its flags, or drop the old version from POLICY_SEMANTICS so old runs are refused, never silently
 * re-interpreted.
 */
import { spawnSync } from 'node:child_process';

/** The version `init` records for a new run. */
export const ENGINE_POLICY_VERSION = 1;

/**
 * Supported version -> capability flags. Version 1 is the engine as it was before the field: no flags.
 * Version 2 (S-01b2 P5r) adds the test-kind freeze gate; `init` records it ONLY for a run that activates
 * test kinds (config.testKinds), so every other run is still version 1, byte for byte.
 */
const BASE_SEMANTICS = Object.freeze({ 1: Object.freeze({}), 2: Object.freeze({ testKinds: true }),
  3: Object.freeze({ securityObligations: true }), 4: Object.freeze({ testKinds: true, securityObligations: true }),
  5: Object.freeze({ pinnedBase: true }), 6: Object.freeze({ testKinds: true, pinnedBase: true }),
  7: Object.freeze({ securityObligations: true, pinnedBase: true }), 8: Object.freeze({ testKinds: true, securityObligations: true, pinnedBase: true }),
  9: Object.freeze({ pinnedBase: true, repoIdentity: true }), 10: Object.freeze({ testKinds: true, pinnedBase: true, repoIdentity: true }),
  11: Object.freeze({ securityObligations: true, pinnedBase: true, repoIdentity: true }),
  12: Object.freeze({ testKinds: true, securityObligations: true, pinnedBase: true, repoIdentity: true }),
  // S1 (P1): 13-24 are 1-12 plus durableRun (hand-coded, as S-12's and S-28a's rows): the run's state, log, usage, attempts
  // and lock live in <git-common-dir>/ai-skills/ship-ticket/runs/<ticket>/ (lib/run-placement.mjs) and every launched
  // attempt carries a persisted deadline. An engine without S1 supports none of 13-24, but it never sees such a run either: it
  // looks only at the legacy placement (no_state), so roll back only after durable runs are finished or retired.
  13: Object.freeze({ durableRun: true }), 14: Object.freeze({ testKinds: true, durableRun: true }),
  15: Object.freeze({ securityObligations: true, durableRun: true }), 16: Object.freeze({ testKinds: true, securityObligations: true, durableRun: true }),
  17: Object.freeze({ pinnedBase: true, durableRun: true }), 18: Object.freeze({ testKinds: true, pinnedBase: true, durableRun: true }),
  19: Object.freeze({ securityObligations: true, pinnedBase: true, durableRun: true }),
  20: Object.freeze({ testKinds: true, securityObligations: true, pinnedBase: true, durableRun: true }),
  21: Object.freeze({ pinnedBase: true, repoIdentity: true, durableRun: true }), 22: Object.freeze({ testKinds: true, pinnedBase: true, repoIdentity: true, durableRun: true }),
  23: Object.freeze({ securityObligations: true, pinnedBase: true, repoIdentity: true, durableRun: true }),
  24: Object.freeze({ testKinds: true, securityObligations: true, pinnedBase: true, repoIdentity: true, durableRun: true }) });

/**
 * PR-3 (STAB S4-min, P6): a second additive offset, composable with every flag of 1-24. Each base version v (1-24) has a
 * stage-obligation twin v + STAGE_OBLIGATIONS_OFFSET (25-48) with the same flags plus stageObligations (config.stagePolicy,
 * S.stage). The twins are DERIVED from the base table and become CORE rows, so S5's early-checks twins (+100) are derived on
 * top of them: a run with both flags records v + 24 + 100 (125-148). Order of composition: every core flag, then stage
 * (+24), then early checks (+100). An engine without PR-3 has no version 25-48 or 125-148 and refuses such a run
 * (policy_version_unsupported) instead of resuming it with its obligations ignored. Every run without config.stagePolicy
 * keeps its version, byte for byte.
 */
export const STAGE_OBLIGATIONS_OFFSET = 24;
const CORE_SEMANTICS = Object.freeze({ ...BASE_SEMANTICS,
  ...Object.fromEntries(Object.entries(BASE_SEMANTICS).map(([v, f]) => [Number(v) + STAGE_OBLIGATIONS_OFFSET, Object.freeze({ ...f, stageObligations: true })])) });
/** The stage-obligation twin of base `version` (1-24) in `table`, or null when that engine has none (an engine without PR-3). */
export const stageVersion = (version, table = POLICY_SEMANTICS) => {
  const w = Number.isInteger(version) && Object.hasOwn(BASE_SEMANTICS, String(version)) ? version + STAGE_OBLIGATIONS_OFFSET : null;
  return w !== null && Object.hasOwn(table, String(w)) && table[w].stageObligations === true && table[w].earlyChecks !== true ? w : null;
};

/**
 * STAB S5 (P5a): an additive capability offset, composable with any other flag. Every core version v (< EARLY_CHECKS_OFFSET)
 * has an early-checks twin v + EARLY_CHECKS_OFFSET with the same flags plus earlyChecks (config.earlyChecks: the pre-review
 * `gate prove` and REVIEW waiting for it). The twins are DERIVED from the core table, so a later slice that adds core rows
 * (S4's stageObligations 25-48, say) gets its early-checks twins without another hand-written row. An engine without S5 has no
 * version >= EARLY_CHECKS_OFFSET and refuses such a run (policy_version_unsupported) instead of resuming it with REVIEW no
 * longer waiting for prove. Every run without config.earlyChecks keeps its core version, byte for byte.
 */
export const EARLY_CHECKS_OFFSET = 100;
/** The core table (every version without earlyChecks; with PR-3 it includes the stage twins 25-48). Exported for the resume regression. */
export const PRE_EARLY_CHECKS_SEMANTICS = CORE_SEMANTICS;
/**
 * `core` plus the early-checks twin of each of its rows. Refuses (policy_table_ceiling), at module load, a core row at or above
 * EARLY_CHECKS_OFFSET or one that already carries earlyChecks: a twin would silently overwrite it and change the meaning of
 * existing runs. The offset is therefore a ceiling on the core table (48 rows with PR-3's stage twins): a later doubling flag that
 * pushes the core to 100 rows must move the offset first.
 */
export function withEarlyChecksTwins(core) {
  const bad = Object.entries(core).filter(([v, f]) => !(Number(v) < EARLY_CHECKS_OFFSET) || f.earlyChecks === true).map(([v]) => v);
  if (bad.length) throw Object.assign(new Error(`policy_table_ceiling: core policy version(s) ${bad.join(', ')} reach EARLY_CHECKS_OFFSET ${EARLY_CHECKS_OFFSET} or already carry earlyChecks`), { code: 'policy_table_ceiling' });
  return Object.freeze({ ...core, ...Object.fromEntries(Object.entries(core).map(([v, f]) => [Number(v) + EARLY_CHECKS_OFFSET, Object.freeze({ ...f, earlyChecks: true })])) });
}
/**
 * PR-2 (S2-min host admission): a second additive offset. Every DURABLE row v (< HOST_CLAIM_OFFSET, durableRun true, after the
 * early-checks twins) has a host-claim twin v + HOST_CLAIM_OFFSET with the same flags plus hostClaimRequired
 * (config.hostClaimRequired: the run-engine CLI entry refuses a heavy command without an active host claim, host_claim_required).
 * DERIVED from the merged table, never hand-assigned, so a later core or twin row gets its host-claim twin automatically. Only
 * durable rows: the check binds a claim to the run's durable state file. An engine without PR-2 has no version >= 200 and
 * refuses such a run (policy_version_unsupported) instead of driving it unclaimed. Every run without the flag keeps its version.
 */
export const HOST_CLAIM_OFFSET = 200;
/** `table` plus the host-claim twin of each durable row; refuses (policy_table_ceiling) a row at or above the offset or already flagged. */
export function withHostClaimTwins(table) {
  const bad = Object.entries(table).filter(([v, f]) => !(Number(v) < HOST_CLAIM_OFFSET) || f.hostClaimRequired === true).map(([v]) => v);
  if (bad.length) throw Object.assign(new Error(`policy_table_ceiling: policy version(s) ${bad.join(', ')} reach HOST_CLAIM_OFFSET ${HOST_CLAIM_OFFSET} or already carry hostClaimRequired`), { code: 'policy_table_ceiling' });
  return Object.freeze({ ...table, ...Object.fromEntries(Object.entries(table).filter(([, f]) => f.durableRun === true)
    .map(([v, f]) => [Number(v) + HOST_CLAIM_OFFSET, Object.freeze({ ...f, hostClaimRequired: true })])) });
}
export const POLICY_SEMANTICS = withHostClaimTwins(withEarlyChecksTwins(CORE_SEMANTICS));
/** The host-claim twin of durable `version` in `table`, or null when that engine has none (non-durable, or an engine without PR-2). */
export const hostClaimVersion = (version, table = POLICY_SEMANTICS) => {
  const w = Number.isInteger(version) && version < HOST_CLAIM_OFFSET ? version + HOST_CLAIM_OFFSET : null;
  return w !== null && Object.hasOwn(table, String(w)) && table[w].hostClaimRequired === true ? w : null;
};
/** The early-checks twin of core `version` in `table`, or null when that engine has none (an engine without S5). */
export const earlyChecksVersion = (version, table = POLICY_SEMANTICS) => {
  const w = Number.isInteger(version) && version < EARLY_CHECKS_OFFSET ? version + EARLY_CHECKS_OFFSET : null;
  return w !== null && Object.hasOwn(table, String(w)) && table[w].earlyChecks === true ? w : null;
};

/**
 * S1 (P1): the durable version of each version 1-12 (its flags plus durableRun). `init` records it for every NEW run unless
 * the DAG sets the documented escape hatch `config.durableRun: false`; a state of version 1-12 keeps its placement and
 * semantics, byte for byte (existing runs are never migrated).
 */
export const DURABLE_VERSION_OF = Object.freeze(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, i + 13])));
/** The durable version for `version` in `table`, or null when that engine has no durable row for it (an engine without S1). */
export const durableVersion = (version, table = POLICY_SEMANTICS) => {
  const w = Object.hasOwn(DURABLE_VERSION_OF, String(version)) ? DURABLE_VERSION_OF[version] : null;
  return w !== null && Object.hasOwn(table, String(w)) && table[w].durableRun === true ? w : null;
};

/** The version `init` records for a run that activates test kinds (design rev 5 section 5). */
export const TEST_KINDS_POLICY_VERSION = 2;

/**
 * F12a: a run whose approved §3a block is format 3 (surface-level facts, dropped pairs that need a review row and
 * reopen on a signal) records version 3, or 4 with test kinds. An engine that predates F12a supports neither, so it
 * refuses such a run outright (policy_version_unsupported) instead of reading its dropped pairs as absent. Every
 * other run keeps version 1 or 2, byte for byte.
 */
export const SECURITY_OBLIGATIONS_POLICY_VERSION = 3;
/** The version `init` records: test kinds and/or a format-3 security block. */
export const recordedVersion = ({ testKinds = false, obligations = false } = {}, current = ENGINE_POLICY_VERSION) =>
  (obligations ? (testKinds ? 4 : SECURITY_OBLIGATIONS_POLICY_VERSION) : testKinds ? TEST_KINDS_POLICY_VERSION : current);

/**
 * S-12 (ASTF-6): a run with config.pinnedBase reads every base from the pinned remote merge base (S.base), never from a local
 * ref, so it records the version of its other flags plus pinnedBase: 1 -> 5, 2 -> 6, 3 -> 7, 4 -> 8. An engine without S-12
 * supports none of 5-8 and refuses such a run (policy_version_unsupported) instead of re-reading it as a local-base run.
 * Every run without the flag keeps 1-4, byte for byte.
 */
export const PINNED_BASE_VERSION_OF = Object.freeze({ 1: 5, 2: 6, 3: 7, 4: 8 });
/** The version a pinned-base run records for `version` (its other flags); a version with no pinned row is refused. */
export const pinnedVersion = (version) => (Object.hasOwn(PINNED_BASE_VERSION_OF, String(version)) ? PINNED_BASE_VERSION_OF[version]
  : (() => { throw Object.assign(new Error(`policy_version_unsupported: no pinned-base policy version for policy_version ${JSON.stringify(version)}`), { code: 'policy_version_unsupported' }); })());

/**
 * S-28a (ASTF-5): a run with config.repoIdentity (which needs config.pinnedBase) is bound to one repository identity and
 * re-verifies it with its base at every gate, so it records its pinned version plus repoIdentity: 5 -> 9, 6 -> 10, 7 -> 11,
 * 8 -> 12 (hand-coded rows, as S-12's). An engine without S-28a supports none of 9-12 and refuses such a run
 * (policy_version_unsupported) instead of re-reading it as a plain pinned run. Every run without the flag keeps 1-8, byte for byte.
 */
export const REPO_IDENTITY_VERSION_OF = Object.freeze({ 5: 9, 6: 10, 7: 11, 8: 12 });
/** The version a repoIdentity run records for its pinned `version`; a version with no identity row is refused. */
export const repoIdentityVersion = (version) => (Number.isInteger(version) && Object.hasOwn(REPO_IDENTITY_VERSION_OF, String(version)) ? REPO_IDENTITY_VERSION_OF[version]
  : (() => { throw Object.assign(new Error(`policy_version_unsupported: no repository-identity policy version for policy_version ${JSON.stringify(version)}`), { code: 'policy_version_unsupported' }); })());

/** The version a state without the key is read as: the oldest supported one. */
export const LEGACY_POLICY_VERSION = 1;

const refuse = (version, supported) => Object.assign(new Error(`policy_version_unsupported: the run records policy_version ${JSON.stringify(version)}, `
  + `but the installed engine supports policy_version ${supported.join(', ')}; resume it with an engine that supports its version `
  + '(reinstall the skill commit recorded as skill_commit), or archive it and start a new run'), { code: 'policy_version_unsupported' });

/** The capability flags of `version` in `table`; anything not a supported key (including null, strings, fractions) is refused. */
export function policySemantics(version, table = POLICY_SEMANTICS) {
  if (!Number.isInteger(version) || !Object.hasOwn(table, String(version))) throw refuse(version, Object.keys(table));
  return table[version];
}

/**
 * The run's version and semantics. `engine` ({ current, semantics }) is an in-process injection
 * (ctx.policy) for tests that simulate an upgraded engine; the CLI never sets it. Only an ABSENT key
 * is legacy: a present malformed value is refused.
 */
export function runPolicy(S, engine = null) {
  const version = Object.hasOwn(S ?? {}, 'policy_version') ? S.policy_version : LEGACY_POLICY_VERSION;
  return { version, semantics: policySemantics(version, engine?.semantics ?? POLICY_SEMANTICS) };
}

/**
 * HEAD of the git checkout that TRACKS `dir/run-engine.mjs`, else 'unknown' (not a work tree, a copy
 * nested untracked in another repository, no git, a timeout). The commit names HEAD only: an
 * uncommitted edit of the installed scripts is not reflected in it. The repository is found from
 * `dir` alone: inherited GIT_* variables are not passed to git.
 */
export function skillCommit(dir) {
  // Every inherited GIT_* variable is dropped: GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE and the like would
  // otherwise point both calls at another repository, whatever `cwd` is, and record that repository's HEAD.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
  const git = (args) => spawnSync('git', args, { cwd: dir, env, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    if (git(['ls-files', '--error-unmatch', '--', 'run-engine.mjs']).status !== 0) return 'unknown';
    const r = git(['rev-parse', '--verify', 'HEAD']);
    const sha = r.status === 0 ? r.stdout.trim() : '';
    return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha) ? sha : 'unknown';
  } catch { return 'unknown'; }
}
