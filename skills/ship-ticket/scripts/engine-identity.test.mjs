/**
 * S-28a (ASTF-5) repository identity: the module's pure parts (state shapes, the DAG field, the policy rows) and its reads in
 * process (an inherited GIT_DIR never redirects the identity read: R14). The gate behaviour is run-engine-identity.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { POSIX, fixture, withOrigin } from './engine-test-fixture.mjs';
import { wellFormedFreezeBase, identityStateHolds, identityRefusal, identityStage, IDENTITY_CODES } from './engine-identity.mjs';
import { validateEngineDag, repoIdentityOn } from './engine-dag.mjs';
import { POLICY_SEMANTICS, REPO_IDENTITY_VERSION_OF, repoIdentityVersion } from './engine-policy.mjs';

const SHA = 'a'.repeat(40), MB = 'b'.repeat(40);
const PIN = { remote: 'origin', identity: 'github.com/acme/app', ref: 'main', sha: SHA, merge_base: MB, pinned_at_seq: 1 };
const FB = { remote: 'origin', identity: 'github.com/acme/app', ref: 'main', sha: 'c'.repeat(40), merge_base: MB };

test('IDENTITY_CODES names the three new codes', () => {
  assert.deepEqual([...IDENTITY_CODES], ['identity_changed', 'identity_unbound', 'identity_state_missing']);
  assert.ok(Object.isFrozen(IDENTITY_CODES));
});

test('wellFormedFreezeBase: exactly { remote, identity, ref, sha, merge_base }, equal to the pin except sha, no coercion', () => {
  assert.equal(wellFormedFreezeBase(FB, PIN), true);
  assert.equal(wellFormedFreezeBase({ ...FB, sha: 'd'.repeat(64) }, PIN), true, 'a SHA-256 repository');
  const { sha: _s, ...noSha } = FB;
  for (const bad of [null, undefined, [], 'x', 0, {}, noSha, { ...FB, extra: 1 }, { ...FB, sha: SHA.slice(0, 39) }, { ...FB, sha: SHA.toUpperCase() },
    { ...FB, sha: 'HEAD' }, { ...FB, remote: 'upstream' }, { ...FB, identity: 'github.com/evil/other' }, { ...FB, identity: null },
    { ...FB, ref: 'trunk' }, { ...FB, merge_base: SHA }, { ...FB, sha: [SHA] }])
    assert.equal(wellFormedFreezeBase(bad, PIN), false, JSON.stringify(bad));
  assert.equal(wellFormedFreezeBase(FB, { ...PIN, identity: null }), false, 'a pin with no identity freezes nothing');
  assert.equal(wellFormedFreezeBase(FB, null), false);
});

test('identityStateHolds: the pin names a repository; a freeze and a SHIP_READY are exact records carrying a well-formed base', () => {
  const S = (over) => ({ base: PIN, freeze: null, ...over });
  assert.equal(identityStateHolds(S()), true, 'before any freeze');
  assert.equal(identityStateHolds(S({ freeze: { candidate: 'sha256:x', seq: 3, base: FB } })), true);
  assert.equal(identityStateHolds(S({ freeze: { candidate: 'sha256:x', seq: 3, base: FB }, ship_ready: { candidate_id: 'sha256:x', seq: 5, base: FB } })), true);
  for (const [name, s] of Object.entries({
    'null identity': S({ base: { ...PIN, identity: null } }),
    'malformed pin': S({ base: { ...PIN, pinned_at_seq: 0 } }),
    'freeze without base': S({ freeze: { candidate: 'sha256:x', seq: 3 } }),
    'freeze with an extra key': S({ freeze: { candidate: 'sha256:x', seq: 3, base: FB, x: 1 } }),
    'freeze with a bad base': S({ freeze: { candidate: 'sha256:x', seq: 3, base: { ...FB, sha: 'x' } } }),
    'ship_ready without base': S({ freeze: { candidate: 'sha256:x', seq: 3, base: FB }, ship_ready: { candidate_id: 'sha256:x', seq: 5 } }),
    'ship_ready null': S({ freeze: { candidate: 'sha256:x', seq: 3, base: FB }, ship_ready: null }),
  })) assert.equal(identityStateHolds(s), false, name);
});

test('DAG: config.repoIdentity is exactly true, needs config.pinnedBase, and is never defaulted', () => {
  const dag = (config) => ({ schema: 'ship-ticket-engine-dag-v1', config: { provider: 'claude', timeoutMs: 120000, ...config }, nodes: [{ id: 'a', promptFile: 'p.txt' }] });
  const pinned = { pinnedBase: { remote: 'origin' } };
  assert.equal(validateEngineDag(dag({ ...pinned, repoIdentity: true })).config.repoIdentity, true);
  assert.equal(validateEngineDag(dag(pinned)).config.repoIdentity, undefined, 'never defaulted');
  assert.throws(() => validateEngineDag(dag({ repoIdentity: true })), (e) => e.code === 'dag_invalid' && /pinnedBase/.test(e.message));
  for (const bad of [false, 1, 'true', {}, null]) assert.throws(() => validateEngineDag(dag({ ...pinned, repoIdentity: bad })), (e) => e.code === 'dag_invalid', JSON.stringify(bad));
  assert.equal(repoIdentityOn({ config: { repoIdentity: true } }), true);
  for (const c of [{}, { repoIdentity: 'true' }, { repoIdentity: 1 }]) assert.equal(repoIdentityOn({ config: c }), false);
  assert.equal(repoIdentityOn(null), false);
});

test('policy: rows 9-12 are rows 5-8 plus repoIdentity, frozen; 1-8 are unchanged; only a pinned version has an identity row', () => {
  assert.deepEqual({ ...REPO_IDENTITY_VERSION_OF }, { 5: 9, 6: 10, 7: 11, 8: 12 });
  for (const [v, w] of Object.entries(REPO_IDENTITY_VERSION_OF)) {
    assert.deepEqual(POLICY_SEMANTICS[w], { ...POLICY_SEMANTICS[v], repoIdentity: true });
    assert.ok(Object.isFrozen(POLICY_SEMANTICS[w]));
    assert.equal(repoIdentityVersion(Number(v)), w);
  }
  for (const v of [1, 2, 3, 4, 5, 6, 7, 8]) assert.equal(POLICY_SEMANTICS[v].repoIdentity, undefined, `v${v} has no identity flag`);
  for (const v of [1, 4, 9, 13, '5', null]) assert.throws(() => repoIdentityVersion(v), (e) => e.code === 'policy_version_unsupported', JSON.stringify(v));
});

test('flag off: identityRefusal and identityStage return null and read nothing (a v5 state on any origin)', () => {
  const E = { S: { config: { pinnedBase: { remote: 'origin' } }, base: { ...PIN, identity: null }, freeze: null }, ctx: { repoRoot: '/nonexistent' } };
  assert.equal(identityRefusal(E, 'reassess'), null);
  for (const stage of ['review', 'confirmation', 'ship-ready']) assert.equal(identityStage(E, stage), null);
});

test('R14 an inherited GIT_DIR (or GIT_CONFIG*) never redirects the identity read to another checkout', { skip: POSIX ? false : 'POSIX git fixture' }, (t) => {
  const a = fixture(t, { commit: true }), b = fixture(t, { commit: true });
  const oa = withOrigin(a, { github: 'acme/app' }), ob = withOrigin(b, { github: 'evil/other' });
  const E = { S: { config: { pinnedBase: { remote: 'origin' }, repoIdentity: true }, base: PIN, freeze: null }, ctx: { repoRoot: a.repo } };
  assert.equal(identityRefusal(E, 'reassess'), null, 'the run\'s own checkout names acme/app');
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { GIT_DIR: ob.gitDir(), GIT_WORK_TREE: b.repo, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'remote.origin.url', GIT_CONFIG_VALUE_0: oa.ghUrl('evil/env') });
    assert.equal(identityRefusal(E, 'reassess'), null, 'neither GIT_DIR nor GIT_CONFIG_* is honoured');
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
  oa.repoint('evil/other');
  const r = identityRefusal(E, 'reassess');
  assert.equal(r?.code, 'identity_changed', JSON.stringify(r));
  assert.equal(r.judgment_point, true);
  assert.equal(r.expected, 'github.com/acme/app');
  assert.equal(r.observed, 'github.com/evil/other');
});
