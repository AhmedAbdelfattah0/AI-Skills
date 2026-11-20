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
export const POLICY_SEMANTICS = Object.freeze({ 1: Object.freeze({}), 2: Object.freeze({ testKinds: true }),
  3: Object.freeze({ securityObligations: true }), 4: Object.freeze({ testKinds: true, securityObligations: true }) });

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
