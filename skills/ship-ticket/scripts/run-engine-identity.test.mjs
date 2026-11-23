/**
 * S-28a (ASTF-5) repository identity, opt-in (`config.repoIdentity: true`, which needs `config.pinnedBase`), driven through the
 * REAL engine (`node run-engine.mjs`) on a temp git repo whose origin is GitHub-shaped: remote.origin.url names
 * https://github.com/acme/app.git and a repo-local `url.<bare>.insteadOf` maps it to a local bare (withOrigin({ github })), so no
 * network is reached. Tests tagged [I#] are the ones engine-identity-mutation.test.mjs expects to fail when guard I# is patched out.
 *
 * The run is bound at init to ONE repository (trust on first use: S.base.identity, non-null). Every later gate review (original
 * and confirmation), gate ship-ready and gate reassess reads the remote's identity again (identity_changed) and the remote base
 * against the base of record (S.base at the original review, the freeze base after it). The freeze and SHIP_READY carry that
 * base record. Every refusal is a judgment point that never latches: the gate writes only its GATE audit line (seq, events,
 * outbox), never a freeze, SHIP_READY, review record, proof or security record, and passes again once the cause is gone.
 * Flag off (v5-8, even on a GitHub origin) the engine is today's: the differential pair R15 is the one intended difference.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, renameSync, readFileSync, writeFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { POSIX, fixture, withOrigin, passReview, failReview, confirmReview } from './engine-test-fixture.mjs';
import * as SP from './security-plan.mjs';
import { init, status, gate as gateCmd } from './run-engine.mjs';
import { POLICY_SEMANTICS } from './engine-policy.mjs';
import { verifyFrozenBase } from './engine-identity.mjs';

const WIN_SKIP = POSIX ? false : 'POSIX process groups: Windows quiescence is unknown, so attempts end in a judgment (known limit N7)';
const ok = (r, msg) => assert.equal(r.status, 0, `${msg ?? ''} ${r.stdout}${r.stderr}`);
const refused = (r, code) => { assert.equal(r.status, 2, `want ${code}: ${r.stdout}${r.stderr}`); assert.equal(r.out?.code, code, r.stdout); return r; };
const initFails = (r, code) => { assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stderr, new RegExp(`run-engine: ${code}:`), r.stderr); };
const noState = (fx) => assert.equal(existsSync(fx.stateFile()), false, 'a refused init writes no state');

const ID = { pinnedBase: { remote: 'origin' }, repoIdentity: true };
const PROOF = { proof: { cmd: process.execPath, args: ['-e', ''] } };
const CANDIDATE_CLI = fileURLToPath(new URL('./candidate-id.mjs', import.meta.url));

/** A run on a GitHub-shaped origin (acme/app), on a ticket branch `feature` made from it; `config` extends the DAG config. */
function idFx(t, { config = {}, github = 'acme/app', feature = true } = {}) {
  const fx = fixture(t, { commit: true, config: { width: 1, base: 'main', testCommands: PROOF, ...ID, ...config },
    behaviour: { a: { write: { 'src/a.txt': 'a1' } }, fix: { write: { 'src/a.txt': 'fixed' } } } });
  const o = withOrigin(fx, github ? { github } : {});
  if (feature) o.feature();
  return { fx, o };
}

/** The candidate measured from the run's pinned merge base (what the engine computes). */
function candidate(fx) {
  const r = spawnSync(process.execPath, [CANDIDATE_CLI, '--repo', fx.repo, '--base', fx.readState().base.merge_base,
    '--exclude', '.specs/plans/T-1.md', '--exclude', 'session-log.md'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).candidate_id;
}

/** init + drive on a GitHub-shaped origin: the run's node is done. */
function started(fx) {
  ok(fx.cli('init', { dag: fx.dagFile }), 'init');
  ok(fx.cli('drive'), 'drive');
}

/** A gate refusal wrote nothing but its GATE audit line: every other state key is as before, and exactly one GATE event was added. */
const AUDIT = ['seq', 'events', 'outbox'];
const sansAudit = (S) => Object.fromEntries(Object.entries(S).filter(([k]) => !AUDIT.includes(k)));
function onlyAudit(fx, before, msg) {
  const after = fx.readState();
  assert.deepEqual(sansAudit(after), sansAudit(before), `${msg}: nothing but the GATE audit line is written`);
  assert.deepEqual(after.events.slice(before.events.length).map(e => [e.type, e.ok]), [['GATE', false]], `${msg}: one GATE line`);
}

/** The freeze base record a run captured: exactly { remote, identity, ref, sha, merge_base }. */
const freezeBase = (S, sha) => ({ remote: S.base.remote, identity: S.base.identity, ref: S.base.ref, sha, merge_base: S.base.merge_base });

// ------------------------------------------------------------------ init: trust on first use

test('[I8] R1 a non-GitHub origin (a local path) is refused at init (identity_unbound, no state); a GitHub origin binds the run', { skip: WIN_SKIP }, (t) => {
  const a = idFx(t, { github: null });
  const r = a.fx.cli('init', { dag: a.fx.dagFile });
  initFails(r, 'identity_unbound');
  noState(a.fx);
  const { fx } = idFx(t);
  ok(fx.cli('init', { dag: fx.dagFile }));
  const S = fx.readState();
  assert.equal(S.base.identity, 'github.com/acme/app');
  assert.equal(S.policy_version, 9, 'a repoIdentity run records the identity policy version (5 + identity)');
  assert.deepEqual(S.events.filter(e => e.type === 'IDENTITY_BOUND').map(({ remote, identity }) => ({ remote, identity })), [{ remote: 'origin', identity: 'github.com/acme/app' }]);
});

// ------------------------------------------------------------------ the re-pointed remote, at every gate

/** A policy-2 run (gate reassess needs it) with an evidenced empty assessment over the REAL catalog, on a GitHub-shaped origin. */
const CATALOG = SP.loadCatalog();
const BOOLS = Object.entries(CATALOG.catalog.fact_vocabulary).filter(([, d]) => d.type === 'bool').map(([k]) => k);
const EMPTY = SP.selectControls(CATALOG, { security_policy: 2, surfaces: [], facts: Object.fromEntries(BOOLS.map(k => [k, false])),
  evidence: Object.fromEntries(BOOLS.map(k => [k, 'src/impl.txt:1'])) });
function secFx(t) {
  const fx = fixture(t, { commit: true, narrativeExtra: SP.renderSection3a(EMPTY) + '\n\n',
    config: { width: 1, base: 'main', securityPolicy: 2, catalogDigest: CATALOG.digest, controlCoverage: [], ...ID },
    nodes: [{ id: 'impl', writes: ['src'] }], behaviour: { impl: { write: { 'src/impl.txt': 'done' } } } });
  const o = withOrigin(fx, { github: 'acme/app' });
  o.feature();
  return { fx, o };
}

test('[I1] R2 reassess: a re-pointed origin is identity_changed (reachable or not: the identity is read first), no latch; restored, it reassesses', { skip: WIN_SKIP }, (t) => {
  assert.equal(EMPTY.ok, true, JSON.stringify(EMPTY));
  const { fx, o } = secFx(t);
  started(fx);
  for (const reachable of [true, false]) {
    o.repoint(reachable ? 'evil/other' : 'evil/offline', { reachable });
    const before = fx.readState();
    const r = refused(fx.gate('reassess', {}), 'identity_changed');
    assert.equal(r.out.judgment_point, true);
    assert.match(r.out.reasons[0], reachable ? /evil\/other/ : /evil\/offline/);
    onlyAudit(fx, before, `reassess (reachable ${reachable})`);
    assert.equal(fx.readState().security?.reapproval, undefined, 'never the security_reapproval latch');
  }
  o.git('remote', 'set-url', 'origin', o.ghUrl('acme/app'));
  const again = fx.gate('reassess', {});
  ok(again, 'restored');
  assert.equal(again.out.code, 'reassessed');
});

test('[I2] [I16] R3 review original: a re-pointed origin is identity_changed before anything is frozen; restored, the original freezes the base', { skip: WIN_SKIP }, (t) => {
  const { fx, o } = idFx(t);
  started(fx);
  const cand = candidate(fx);
  o.repoint('evil/other');
  const before = fx.readState();
  const r = refused(fx.gate('review', passReview('rx-1', cand)), 'identity_changed');
  assert.equal(r.out.judgment_point, true);
  onlyAudit(fx, before, 'review original');
  assert.equal(fx.readState().freeze, null);
  assert.deepEqual(fx.readState().review_chain, []);
  // P3: re-pointed at an UNREACHABLE URL the code is still identity_changed: the identity is read before the base
  o.repoint('evil/offline', { reachable: false });
  refused(fx.gate('review', passReview('rx-1', cand)), 'identity_changed');
  // a remote re-pointed at a plain path names no repository at all: also identity_changed, never a pass
  o.git('remote', 'set-url', 'origin', o.origin);
  refused(fx.gate('review', passReview('rx-1', cand)), 'identity_changed');
  o.git('remote', 'set-url', 'origin', o.ghUrl('acme/app'));
  ok(fx.gate('review', passReview('rx-1', cand)), 'restored');
  assert.ok(fx.readState().freeze?.base, 'the original froze a base');
});

/** A FAIL original, then its repair recorded (the re-freeze): the run waits for the confirmation of rx-1. */
function repaired(fx) {
  started(fx);
  ok(fx.gate('review', failReview('rx-1', candidate(fx), 'src/a.txt', fx.prompt('fix'))), 'FAIL original');
  const d = fx.cli('drive');
  ok(d, 'drive the repair');
  assert.equal(d.out.repairs[0].state, 'done');
  return candidate(fx);
}

test('[I3] [I16] R4 review confirmation: a re-pointed origin is identity_changed after a recorded repair; restored, the confirmation passes', { skip: WIN_SKIP }, (t) => {
  const { fx, o } = idFx(t);
  const c2 = repaired(fx);
  o.repoint('evil/other');
  const before = fx.readState();
  refused(fx.gate('review', confirmReview('rx-1', c2)), 'identity_changed');
  onlyAudit(fx, before, 'review confirmation');
  o.repoint('evil/offline', { reachable: false }); // P3: identity before base
  refused(fx.gate('review', confirmReview('rx-1', c2)), 'identity_changed');
  o.git('remote', 'set-url', 'origin', o.ghUrl('acme/app'));
  ok(fx.gate('review', confirmReview('rx-1', c2)), 'restored');
});

test('[I4] [I16] R5 ship-ready: a re-pointed origin is identity_changed before the proof runs; restored, the run is SHIP_READY', { skip: WIN_SKIP }, (t) => {
  const { fx, o } = idFx(t);
  started(fx);
  ok(fx.gate('review', passReview('rx-1', candidate(fx))));
  o.repoint('evil/other');
  const before = fx.readState();
  refused(fx.gate('ship-ready', {}), 'identity_changed');
  onlyAudit(fx, before, 'ship-ready');
  assert.equal(fx.readState().ship_ready, undefined);
  assert.equal(fx.readState().local_proof, undefined, 'the proof never ran');
  o.repoint('evil/offline', { reachable: false }); // P3: identity before base
  refused(fx.gate('ship-ready', {}), 'identity_changed');
  o.git('remote', 'set-url', 'origin', o.ghUrl('acme/app'));
  const r = fx.gate('ship-ready', {});
  ok(r, 'restored');
  assert.equal(r.out.code, 'ship_ready');
});

// ------------------------------------------------------------------ the base of record in the freeze and SHIP_READY

test('[I5] R7 the original freezes the remote head as the base of record; a remote that advanced later passes and SHIP_READY keeps the freeze base', { skip: WIN_SKIP }, (t) => {
  const { fx, o } = idFx(t);
  started(fx);
  const head = o.upstream(2); // the remote advanced after init, before the review
  o.fetch();
  ok(fx.gate('review', passReview('rx-1', candidate(fx))));
  let S = fx.readState();
  assert.deepEqual(S.freeze.base, freezeBase(S, head), 'freeze.base is the remote head at the freeze, with the pinned merge base');
  assert.deepEqual(S.events.filter(e => e.type === 'BASE_FROZEN').map(({ seq: _s, type: _t, ...rest }) => rest), [{ review_execution: 'rx-1', ...freezeBase(S, head) }]);
  o.upstream(1);
  o.fetch();
  const r = fx.gate('ship-ready', {});
  ok(r, 'an advanced remote is accepted');
  S = fx.readState();
  assert.deepEqual(S.ship_ready.base, S.freeze.base, 'SHIP_READY binds the freeze base, never the advanced head');
  assert.equal(S.ship_ready.base.sha, head);
});

test('[I7] R6 a remote force-pushed below the freeze (above the pin) is base_moved_remote at ship-ready; an owner RETRY re-freezes and passes', { skip: WIN_SKIP }, (t) => {
  const { fx, o } = idFx(t);
  started(fx);
  const x1 = o.upstream(1);
  const x2 = o.upstream(1);
  o.fetch();
  const cand = candidate(fx);
  ok(fx.gate('review', passReview('rx-1', cand)));
  assert.equal(fx.readState().freeze.base.sha, x2);
  o.rewind(x1);
  const before = fx.readState();
  refused(fx.gate('ship-ready', {}), 'base_moved_remote');
  onlyAudit(fx, before, 'ship-ready after a rewind');
  fx.appendRunState({ run_id: 'run-1', event: 'RETRY', review_execution: 'rx-2', predecessor: 'rx-1', authorized_by: 'owner' });
  ok(fx.gate('review', passReview('rx-2', cand)), 'a new original captures the remote head now');
  assert.equal(fx.readState().freeze.base.sha, x1);
  ok(fx.gate('ship-ready', {}));
  assert.equal(fx.readState().ship_ready.base.sha, x1);
});

test('R6 the same rewind at the confirmation is base_moved_remote; after an owner RETRY the run is SHIP_READY on the new freeze base', { skip: WIN_SKIP }, (t) => {
  const { fx, o } = idFx(t);
  started(fx);
  const x1 = o.upstream(1);
  o.upstream(1);
  o.fetch();
  ok(fx.gate('review', failReview('rx-1', candidate(fx), 'src/a.txt', fx.prompt('fix'))));
  ok(fx.cli('drive'), 'drive the repair');
  const c2 = candidate(fx);
  o.rewind(x1);
  refused(fx.gate('review', confirmReview('rx-1', c2)), 'base_moved_remote');
  refused(fx.gate('ship-ready', {}), 'base_moved_remote');
  fx.appendRunState({ run_id: 'run-1', event: 'RETRY', review_execution: 'rx-2', predecessor: 'rx-1', authorized_by: 'owner' });
  ok(fx.gate('review', passReview('rx-2', c2)));
  ok(fx.gate('ship-ready', {}));
  assert.equal(fx.readState().ship_ready.base.sha, x1);
});

test('[I6] R9 a repair re-freeze keeps the frozen base, and the confirmation verifies against it', { skip: WIN_SKIP }, (t) => {
  const { fx } = idFx(t);
  started(fx);
  ok(fx.gate('review', failReview('rx-1', candidate(fx), 'src/a.txt', fx.prompt('fix'))));
  const frozen = fx.readState().freeze;
  ok(fx.cli('drive'), 'drive the repair');
  const S = fx.readState();
  assert.notEqual(S.freeze.candidate, frozen.candidate, 'the repair re-froze the candidate');
  assert.deepEqual(S.freeze.base, frozen.base, 'and kept the base of record');
  ok(fx.gate('review', confirmReview('rx-1', candidate(fx))), 'the confirmation passes');
  ok(fx.gate('ship-ready', {}));
});

test('R8 a pinned run without securityPolicy: a local base branch moved after the review is base_moved_local at ship-ready (the gap before S-28a)', { skip: WIN_SKIP }, (t) => {
  const { fx, o } = idFx(t);
  started(fx);
  ok(fx.gate('review', passReview('rx-1', candidate(fx))));
  const pinned = fx.readState().base.merge_base;
  o.git('branch', '-f', 'main', 'main~1');
  const r = refused(fx.gate('ship-ready', {}), 'base_moved_local');
  assert.equal(r.out.expected, pinned);
  assert.equal(r.out.observed, o.sha('main'));
  o.git('branch', '-f', 'main', pinned);
  ok(fx.gate('ship-ready', {}), 'the local base reset, it passes');
});

test('R13 a second fetch URL appearing mid-run is remote_ambiguous at review, nothing frozen', { skip: WIN_SKIP }, (t) => {
  const { fx, o } = idFx(t);
  started(fx);
  o.git('config', '--add', 'remote.origin.url', o.ghUrl('acme/app'));
  const before = fx.readState();
  refused(fx.gate('review', passReview('rx-1', candidate(fx))), 'remote_ambiguous');
  onlyAudit(fx, before, 'review with two URLs');
});

test('R16 offline at review and at ship-ready is base_remote_unavailable, nothing written; back online both pass', { skip: WIN_SKIP }, (t) => {
  const { fx, o } = idFx(t);
  started(fx);
  const cand = candidate(fx);
  renameSync(o.origin, o.origin + '.away');
  let before = fx.readState();
  refused(fx.gate('review', passReview('rx-1', cand)), 'base_remote_unavailable');
  onlyAudit(fx, before, 'review offline');
  renameSync(o.origin + '.away', o.origin);
  ok(fx.gate('review', passReview('rx-1', cand)));
  renameSync(o.origin, o.origin + '.away');
  before = fx.readState();
  refused(fx.gate('ship-ready', {}), 'base_remote_unavailable');
  onlyAudit(fx, before, 'ship-ready offline');
  renameSync(o.origin + '.away', o.origin);
  ok(fx.gate('ship-ready', {}));
});

// ------------------------------------------------------------------ H2: the default branch of record is the remote's

test('[I11] R12 HEAD mode: a local refs/remotes/origin/HEAD repointed before init does not choose the base; the remote\'s default branch does', { skip: WIN_SKIP }, (t) => {
  const { fx, o } = idFx(t, { config: { base: 'HEAD' } });
  o.git('push', '-q', 'origin', 'HEAD:refs/heads/other');
  o.fetch();
  o.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/other');
  ok(fx.cli('init', { dag: fx.dagFile }));
  assert.equal(fx.readState().base.ref, 'main', 'the ref of record is what the remote names (ls-remote --symref), not the local symref');
});

// ------------------------------------------------------------------ load: strict state, never a partial activation resumed

test('[I9] [I10] R10 load refuses identity_state_missing: flag, semantics and config disagree; a null identity; a malformed freeze or SHIP_READY base', { skip: WIN_SKIP }, async (t) => {
  const { fx } = idFx(t);
  started(fx);
  ok(fx.gate('review', passReview('rx-1', candidate(fx))));
  ok(fx.gate('ship-ready', {}));
  const saved = readFileSync(fx.stateFile(), 'utf8');
  const good = JSON.parse(saved);
  const fb = good.freeze.base;
  const { ref: _r, ...noRef } = fb;
  const cases = {
    'version 5 with config.repoIdentity': (s) => { s.policy_version = 5; },
    'version 9 without config.repoIdentity': (s) => { delete s.config.repoIdentity; },
    'S.base.identity null': (s) => { s.base.identity = null; },
    'freeze without base': (s) => { delete s.freeze.base; },
    'freeze.base missing a key': (s) => { s.freeze.base = noRef; },
    'freeze.base with an extra key': (s) => { s.freeze.base = { ...fb, remote_head: fb.sha }; },
    'freeze.base with a short sha': (s) => { s.freeze.base = { ...fb, sha: fb.sha.slice(0, 12) }; },
    'freeze.base with another merge_base': (s) => { s.freeze.base = { ...fb, merge_base: 'f'.repeat(40) }; },
    'freeze.base naming another repository': (s) => { s.freeze.base = { ...fb, identity: 'github.com/evil/other' }; },
    'freeze with an extra key': (s) => { s.freeze.extra = 1; },
    'ship_ready without base': (s) => { delete s.ship_ready.base; },
    'ship_ready.base malformed': (s) => { s.ship_ready.base = { ...fb, sha: 'HEAD' }; },
  };
  for (const [name, edit] of Object.entries(cases)) {
    writeFileSync(fx.stateFile(), saved);
    fx.editState(edit);
    await assert.rejects(status(fx.ctx()), (e) => e.code === 'identity_state_missing', name);
    assert.equal(fx.gate('review', passReview('rx-9', fb.sha)).out?.code, 'identity_state_missing', name);
  }
  writeFileSync(fx.stateFile(), saved);
  await status(fx.ctx());
});

// ------------------------------------------------------------------ policy versions, flag off, the differential

test('R11 policy: 9-12 are 5-8 plus repoIdentity; an S-12 engine (rows 1-8) refuses a repoIdentity run at init and on load', { skip: WIN_SKIP }, async (t) => {
  for (const [v, w] of [[5, 9], [6, 10], [7, 11], [8, 12]]) assert.deepEqual(POLICY_SEMANTICS[w], { ...POLICY_SEMANTICS[v], repoIdentity: true });
  const s12 = { current: 1, semantics: Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map(v => [v, POLICY_SEMANTICS[v]])) };
  const { fx } = idFx(t);
  await assert.rejects(init(fx.ctx({ policy: s12 })), (e) => e.code === 'policy_version_unsupported');
  noState(fx);
  await init(fx.ctx());
  await assert.rejects(status(fx.ctx({ policy: s12 })), (e) => e.code === 'policy_version_unsupported');
  assert.equal((await gateCmd(fx.ctx({ policy: s12, gate: 'review', input: passReview('rx-1', 'x') }))).code, 'policy_version_unsupported');
});

test('R15 flag off on a GitHub-shaped origin (v5, S.base.identity non-null) runs as today: no freeze or SHIP_READY base, a re-pointed origin passes review', { skip: WIN_SKIP }, (t) => {
  const { fx, o } = idFx(t, { config: { repoIdentity: undefined } });
  started(fx);
  let S = fx.readState();
  assert.equal(S.policy_version, 5);
  assert.equal(S.base.identity, 'github.com/acme/app', 'a v5 run on a GitHub origin records an identity (the invariant is one-way)');
  assert.ok(!S.events.some(e => ['IDENTITY_BOUND', 'BASE_FROZEN'].includes(e.type)));
  o.repoint('evil/other');
  ok(fx.gate('review', passReview('rx-1', candidate(fx))), 'the differential: v5 passes the re-pointed review, v9 refuses it (R3)');
  ok(fx.gate('ship-ready', {}));
  S = fx.readState();
  assert.deepEqual(Object.keys(S.freeze).sort(), ['candidate', 'seq']);
  assert.deepEqual(Object.keys(S.ship_ready).sort(), ['candidate_id', 'seq']);
});

// ------------------------------------------------------------------ Round 1 repairs

/** Point remote.origin.url at `url`, mapped by insteadOf to the bare (so only its identity differs). */
const pointAt = (o, url) => { o.git('config', '--add', `url.${o.origin}.insteadOf`, url); o.git('remote', 'set-url', 'origin', url); };

test('[I14] R1b only a repository ON github.com binds: another host (gitlab.com) or a github.com port is identity_unbound; the scp form binds', { skip: WIN_SKIP }, (t) => {
  for (const url of ['https://gitlab.com/acme/app.git', 'https://github.com:8443/acme/app.git', 'ssh://git@github.com:22/acme/app.git']) {
    const { fx, o } = idFx(t, { github: null });
    pointAt(o, url);
    const r = fx.cli('init', { dag: fx.dagFile });
    initFails(r, 'identity_unbound');
    noState(fx);
  }
  const { fx, o } = idFx(t, { github: null });
  pointAt(o, 'git@github.com:acme/app.git');
  ok(fx.cli('init', { dag: fx.dagFile }), 'the scp form of a github.com URL binds');
  assert.equal(fx.readState().base.identity, 'github.com/acme/app');
});

test('[I15] a mid-run re-point to the same owner/repo on a github.com port (or another host) is identity_changed at review', { skip: WIN_SKIP }, (t) => {
  const { fx, o } = idFx(t);
  started(fx);
  const cand = candidate(fx);
  for (const url of ['https://github.com:8443/acme/app.git', 'https://gitlab.com/acme/app.git']) {
    pointAt(o, url);
    const r = refused(fx.gate('review', passReview('rx-1', cand)), 'identity_changed');
    assert.equal(r.out.observed, null, url);
  }
  o.git('remote', 'set-url', 'origin', o.ghUrl('acme/app'));
  ok(fx.gate('review', passReview('rx-1', cand)));
});

/** A run whose ship-ready proof command is `args` (git), with the evil URL mapped to the bare. */
function proofFx(t, args) {
  const r = idFx(t, { config: { testCommands: { proof: { cmd: 'git', args } } } });
  r.o.git('config', '--add', `url.${r.o.origin}.insteadOf`, r.o.ghUrl('evil/other'));
  return r;
}

test('[I12] P1 a proof command that re-points origin is identity_changed at ship-ready: the proof is dropped, nothing is SHIP_READY', { skip: WIN_SKIP }, (t) => {
  const { fx } = proofFx(t, ['remote', 'set-url', 'origin', 'https://github.com/evil/other.git']);
  started(fx);
  ok(fx.gate('review', passReview('rx-1', candidate(fx))));
  const r = refused(fx.gate('ship-ready', {}), 'identity_changed');
  assert.equal(r.out.observed, 'github.com/evil/other');
  const S = fx.readState();
  assert.equal(S.ship_ready, undefined);
  assert.deepEqual([S.local_proof?.candidate_id, S.local_proof?.dropped], [null, ['identity_changed']], 'the proof is bound to no candidate');
});

test('[I12] P1 a proof command that moves the local base branch is base_moved_local at ship-ready: the proof is dropped', { skip: WIN_SKIP }, (t) => {
  const { fx } = proofFx(t, ['branch', '-f', 'main', 'main~1']);
  started(fx);
  ok(fx.gate('review', passReview('rx-1', candidate(fx))));
  refused(fx.gate('ship-ready', {}), 'base_moved_local');
  const S = fx.readState();
  assert.equal(S.ship_ready, undefined);
  assert.deepEqual([S.local_proof?.candidate_id, S.local_proof?.dropped], [null, ['base_moved_local']]);
});

test('[I17] P2 after SHIP_READY, a rewind and an owner RETRY of the same candidate move SHIP_READY\'s base to the new freeze base', { skip: WIN_SKIP }, (t) => {
  const { fx, o } = idFx(t);
  started(fx);
  const x1 = o.upstream(1);
  const x2 = o.upstream(1);
  o.fetch();
  const cand = candidate(fx);
  ok(fx.gate('review', passReview('rx-1', cand)));
  ok(fx.gate('ship-ready', {}));
  assert.equal(fx.readState().ship_ready.base.sha, x2);
  o.rewind(x1);
  refused(fx.gate('ship-ready', {}), 'base_moved_remote');
  fx.appendRunState({ run_id: 'run-1', event: 'RETRY', review_execution: 'rx-2', predecessor: 'rx-1', authorized_by: 'owner' });
  ok(fx.gate('review', passReview('rx-2', cand)));
  ok(fx.gate('ship-ready', {}));
  const S = fx.readState();
  assert.equal(S.ship_ready.candidate_id, cand, 'the same candidate');
  assert.deepEqual(S.ship_ready.base, S.freeze.base, 'SHIP_READY binds the new freeze base');
  assert.equal(S.ship_ready.base.sha, x1);
});

test('[I18] a branch that merges the advanced base before the review is base_moved_local at the original (expected the pin, observed the new merge base)', { skip: WIN_SKIP }, (t) => {
  const { fx, o } = idFx(t);
  started(fx);
  const pinned = fx.readState().base.merge_base;
  const now = o.upstream(2);
  o.fetch();
  o.git('merge', '-q', '--ff-only', 'origin/main');
  const r = refused(fx.gate('review', passReview('rx-1', candidate(fx))), 'base_moved_local');
  assert.deepEqual([r.out.expected, r.out.observed], [pinned, now]);
  assert.equal(fx.readState().freeze, null);
});

/** An in-process engine context of an initialised run (the exports S-28b/S-14 call). */
const ctxOf = (fx) => ({ S: fx.readState(), ctx: { repoRoot: fx.repo } });

test('[I13] the base is read by the identity-checked URL, never re-read from config (a URL changed between the reads is not the one verified)', { skip: WIN_SKIP }, (t) => {
  const { fx, o } = idFx(t);
  ok(fx.cli('init', { dag: fx.dagFile }));
  const E = ctxOf(fx);
  o.repoint('evil/offline', { reachable: false }); // the configured URL now differs from the one the identity read returned
  const v = verifyFrozenBase(E, E.S.base, o.ghUrl('acme/app'));
  assert.deepEqual([v.ok, v.base?.sha], [true, E.S.base.sha], JSON.stringify(v));
});

test('[I19] verifyFrozenBase has strict inputs: no freeze base, a copy of the pin or no identity-checked URL is base_unverified, never a skipped rewind check', { skip: WIN_SKIP }, (t) => {
  const { fx, o } = idFx(t);
  ok(fx.cli('init', { dag: fx.dagFile }));
  const E = ctxOf(fx), url = o.ghUrl('acme/app');
  for (const [name, recorded, u] of [['no record', undefined, url], ['null record', null, url], ['a copy of the pin', { ...E.S.base }, url],
    ['no URL', E.S.base, undefined], ['a local path', E.S.base, o.origin], ['another host', E.S.base, 'https://gitlab.com/acme/app.git']])
    assert.equal(verifyFrozenBase(E, recorded, u).code, 'base_unverified', name);
  assert.equal(verifyFrozenBase(E, E.S.base, url).ok, true, 'the pin itself, by the checked URL');
});

// ------------------------------------------------------------------ R11 (Round 1): version 11 end to end

/** A format-3 selection over the REAL catalog (security-obligations.test.mjs realSelection): one request handler lowers session_context. */
function formatThree() {
  const facts = { ...Object.fromEntries(BOOLS.map((b) => [b, false])), session_context: true };
  const surfaces = [{ boundary_id: 'orders', kind: 'request-handler', path: 'src/orders.ts', principals: ['staff'], facts: { session_context: false }, evidence: { session_context: 'src/orders.ts:bearerOnly' } },
    { boundary_id: 'forms', kind: 'server-input', path: 'src/forms.ts', principals: ['staff'] }];
  const r = SP.selectControls(CATALOG, { security_policy: 2, surfaces, facts, evidence: Object.fromEntries(BOOLS.map((b) => [b, 'src/orders.ts:handler'])) });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}

test('R11 a format-3 security block with repoIdentity records version 11 (7 + identity); the composition holds for every pinned version', { skip: WIN_SKIP }, async (t) => {
  const { pinnedVersion, repoIdentityVersion, recordedVersion } = await import('./engine-policy.mjs');
  for (const testKinds of [false, true]) for (const obligations of [false, true]) {
    const w = repoIdentityVersion(pinnedVersion(recordedVersion({ testKinds, obligations })));
    assert.deepEqual(POLICY_SEMANTICS[w], { ...(testKinds ? { testKinds: true } : {}), ...(obligations ? { securityObligations: true } : {}), pinnedBase: true, repoIdentity: true }, `v${w}`);
  }
  const sel = formatThree(), SPEC = 'spec/sec.test.mjs';
  const cov = sel.pairs.map((p) => ({ boundary: p.boundary_id, control: p.control_id, node: 'api', specs: [{ file: SPEC, name: p.pair_id }] }));
  const fx = fixture(t, { commit: true, narrativeExtra: SP.renderSection3a(sel) + '\n\n',
    config: { width: 1, base: 'main', securityPolicy: 2, catalogDigest: CATALOG.digest, controlCoverage: cov, ...ID },
    nodes: [{ id: 'api', writes: ['spec'], redSpecs: cov.flatMap((c) => c.specs) }, { id: 'impl', deps: ['api'], writes: ['src'] }] });
  const o = withOrigin(fx, { github: 'acme/app' });
  o.feature();
  ok(fx.cli('init', { dag: fx.dagFile }));
  assert.equal(fx.readState().policy_version, 11);
});

// ------------------------------------------------------------------ R15 (Round 1): flag-off byte replay against origin/main's engine

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
/** origin/main's skills/ extracted to a temp dir: the pre-S-28a engine; null in a checkout without origin/main (a shallow CI or a mutant copy). */
function mainEngine(t) {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: SCRIPTS, encoding: 'utf8' });
  if (top.status !== 0) return null;
  if (spawnSync('git', ['rev-parse', '--verify', '--quiet', 'origin/main^{commit}'], { cwd: top.stdout.trim() }).status !== 0) return null;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 's28a-main-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ar = spawnSync('sh', ['-c', `git -C "${top.stdout.trim()}" archive origin/main skills | tar -x -C "${dir}"`], { encoding: 'utf8' });
  assert.equal(ar.status, 0, ar.stderr);
  return join(dir, 'skills', 'ship-ticket', 'scripts', 'run-engine.mjs');
}
const VOLATILE = new Set(['dag_digest', 'plan_digest', 'approved_plan_digest', 'dag_file', 'created_at', 'timestamp', 'started_at', 'ended_at', 'pid', 'pgid', 'leader_start', 'skill_commit', 'at', 'duration_ms', 'event_id']);
function normal(v, root) {
  if (Array.isArray(v)) return v.map(x => normal(x, root));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, VOLATILE.has(k) ? '<v>' : normal(x, root)]));
  return typeof v === 'string' ? v.split(root).join('<root>').replace(/sha256:[0-9a-f]{64}/g, '<sha256>').replace(/att-[0-9a-f-]{36}/g, '<att>').replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<ts>') : v;
}

test('R15 flag off, byte replay: v1 and v5 (pinned, GitHub origin) runs give the same state, events, outputs and engine log on origin/main\'s engine and this one', { skip: WIN_SKIP }, (t) => {
  const mainCli = mainEngine(t);
  if (mainCli === null) { t.skip('origin/main is not in this checkout: the replay needs the pre-S-28a engine and runs locally'); return; }
  for (const pinned of [false, true]) {
    const scenario = (cli) => {
      const fx = fixture(t, { commit: true, config: { width: 1, base: 'main', testCommands: PROOF, ...(pinned ? { pinnedBase: { remote: 'origin' } } : {}) },
        behaviour: { a: { write: { 'src/a.txt': 'a1' } }, fix: { write: { 'src/a.txt': 'fixed' } } } });
      const o = withOrigin(fx, { github: 'acme/app' });
      o.feature();
      const run = (cmd, flags = {}) => spawnSync(process.execPath, [cli, ...cmd.split(' '), '--repo', fx.repo, '--ticket', 'T-1', '--run-id', 'run-1',
        ...Object.entries(flags).flatMap(([k, v]) => [`--${k}`, v])], { encoding: 'utf8', env: fx.env, timeout: 60000 });
      let n = 0;
      const gate = (kind, input) => { const f = join(fx.root, `in-${++n}.json`); writeFileSync(f, JSON.stringify(input)); return run(`gate ${kind}`, { input: f }); };
      const outs = [];
      const step = (r) => { assert.ok([0, 2].includes(r.status), r.stdout + r.stderr); outs.push(JSON.parse(r.stdout)); };
      step(run('init', { dag: fx.dagFile }));
      step(run('drive'));
      step(gate('review', failReview('rx-1', fx.candidate(), 'src/a.txt', fx.prompt('fix'))));
      step(run('drive'));
      step(gate('review', confirmReview('rx-1', fx.candidate())));
      step(gate('ship-ready', {}));
      step(run('status'));
      return { outs: normal(outs, fx.root), state: normal(fx.readState(), fx.root), log: normal(readFileSync(fx.engineLog(), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)), fx.root) };
    };
    const before = scenario(mainCli), after = scenario(join(SCRIPTS, 'run-engine.mjs'));
    assert.equal(after.outs.at(-2).code, 'ship_ready', `the replay reaches SHIP_READY (pinned ${pinned})`);
    assert.deepEqual(after.outs, before.outs, `command outputs, status included (pinned ${pinned})`);
    assert.deepEqual(after.state, before.state, `state (pinned ${pinned})`);
    assert.deepEqual(after.log, before.log, `engine log (pinned ${pinned})`);
    assert.equal(after.state.policy_version, pinned ? 5 : 1);
  }
});
