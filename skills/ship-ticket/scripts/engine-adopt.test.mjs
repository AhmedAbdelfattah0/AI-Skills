/**
 * S-13a (ASTF-7) run adoption, same base: the pure verdicts and source checks of engine-adopt.mjs.
 *
 * Contract (PLAN-S13 §4): a new run (zero attempts, every node pending) adopts an archived run's `done` nodes whose definition
 * (ADOPT_NODE_FIELDS) is unchanged and whose read/write fingerprints still match the work tree; every dependent of a node that is
 * not adopted is not adopted either (transitive invalidation, `dep_not_adopted`). A RED-bearing node is adopted only with its
 * archived RED evidence, carried verbatim, and only when `redChanges` finds nothing (same spec bytes, same base); otherwise it
 * is `adopt_red_unverified` (or `adopt_red_missing`), a human-owned judgment. Whole refusals: `adopt_source_outside`,
 * `adopt_archive_invalid`, `adopt_source_live`, `adopt_plan_mismatch`, `adopt_policy_mismatch`, `adopt_units_unsupported`,
 * `policy_version_unsupported`. Tags [D#] name the mutant of engine-adopt-mutation.test.mjs each test kills.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, symlinkSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { adoptable, sourceRefusal, windowRefusal, readArchive, applyAdoption, retireRefusal, ADOPT_NODE_FIELDS } from './engine-adopt.mjs';

const LINK_SKIP = process.platform === 'win32' ? 'symlinks need a privilege on Windows' : false;
const sha = (b) => 'sha256:' + createHash('sha256').update(b).digest('hex');
const SPEC = { file: 'spec/api.test.mjs', name: 'rejects' };
const RUNNER = { unit: { cmd: 'node', args: ['--test'], format: 'tap' } };
const node = (id, over = {}) => ({ id, deps: [], reads: [], writes: [`src/${id}.txt`], othersOwned: [], resources: [], risk: [], complexity: 'low',
  modelTier: 'inherit', estimatedMemoryMb: 64, promptFile: `/p/${id}.txt`, phase: 'BUILD', role: 'builder', evidence: [], redSpecs: [], ...over });
const fpsOf = (n) => Object.fromEntries([...n.reads, ...n.writes].map(p => [p, `fp:${p}`]));
/** An ARC-shaped graph (fact 6): api-red (RED) -> api-impl; web-red -> web-state -> web-ui. */
const GRAPH = () => [node('api-red', { writes: ['spec/api.test.mjs'], redSpecs: [SPEC] }), node('api-impl', { deps: ['api-red'], reads: ['spec/api.test.mjs'] }),
  node('web-red'), node('web-state', { deps: ['web-red'], reads: ['src/web-red.txt'] }), node('web-ui', { deps: ['web-state'] })];
const EV = { node: 'api-red', attempt_id: 'gr-1', seq: 7, format: 'tap', baseline_candidate: 'cand-1', spec_digests: { 'spec/api.test.mjs': 'd1' }, specs: [SPEC],
  command: 'unit', base_commit: 'a'.repeat(40) };
function archived(nodes = GRAPH(), over = {}) {
  return { schema: 'ship-ticket-engine-state-v1', ticket: 'T-1', run_id: 'run-1', plan_digest: 'sha256:plan', config: { testCommands: RUNNER },
    nodes: Object.fromEntries(nodes.map(n => [n.id, { ...n, state: 'done', attempts: 1, retries: 0, fps: fpsOf(n) }])),
    attempts: [{ attempt_id: 'w1', status: 'exited', quiesced: true }], gates: { red: { 'api-red': structuredClone(EV) } }, events: [], judgments: [], usage: [], ...over };
}
function fresh(nodes = GRAPH(), over = {}) {
  return { schema: 'ship-ticket-engine-state-v1', ticket: 'T-1', run_id: 'run-2', plan_digest: 'sha256:plan', config: { testCommands: RUNNER }, seq: 0,
    nodes: Object.fromEntries(nodes.map(n => [n.id, { ...n, state: 'pending', attempts: 0, retries: 0, fps: null }])),
    attempts: [], gates: { red: {} }, events: [], judgments: [], freeze: null, review_chain: [], repairs: [], usage: [], ...over };
}
/** The world: every fingerprint as archived, RED unchanged; `changedFps` paths differ now; `red` overrides redChanges. */
const world = ({ changedFps = [], red = () => null } = {}) => ({
  fingerprints: (paths) => Object.fromEntries(paths.map(p => [p, changedFps.includes(p) ? 'fp:edited' : `fp:${p}`])), redChanges: red });
const run = (oldS, newS, w = world()) => adoptable({ oldS, newS, ...w });
const codeOf = (v, id) => v.rejected.find(r => r.node === id)?.code;

test('[AC1] unchanged ARC-shaped run: every node adopted, api-red RED carried verbatim', () => {
  const v = run(archived(), fresh());
  assert.deepEqual(v.adopted, ['api-impl', 'api-red', 'web-red', 'web-state', 'web-ui']);
  assert.deepEqual(v.rejected, []);
  assert.deepEqual(v.red, { 'api-red': EV }, 'the carried evidence is the archived object, byte for byte');
  assert.deepEqual(v.judgments, []);
});

test('[D1] an edited write rejects that node (node_files_changed), and its dependents only by dependency', () => {
  const v = run(archived(), fresh(), world({ changedFps: ['src/web-ui.txt'] }));
  assert.equal(codeOf(v, 'web-ui'), 'node_files_changed');
  assert.deepEqual(v.adopted, ['api-impl', 'api-red', 'web-red', 'web-state']);
});

test('[D2] transitive invalidation: dependents of a changed node are dep_not_adopted even when their own files are unchanged (K #9)', () => {
  // web-ui does not read web-state's file: only closure() can reject it
  const v = run(archived(), fresh(), world({ changedFps: ['src/web-red.txt'] }));
  assert.equal(codeOf(v, 'web-red'), 'node_files_changed');
  assert.equal(codeOf(v, 'web-state'), 'node_files_changed', 'web-state reads the changed file');
  assert.equal(codeOf(v, 'web-ui'), 'dep_not_adopted');
  assert.deepEqual(v.adopted, ['api-impl', 'api-red']);
});

test('[D8] a changed deps, writes or redSpecs is node_scope_changed (AC2 scope), never adopted', () => {
  for (const [field, over] of [['deps', { deps: [] }], ['writes', { writes: ['src/other.txt'] }], ['reads', { reads: [] }]]) {
    const g = GRAPH().map(n => (n.id === 'api-impl' ? { ...n, ...over } : n));
    const v = run(archived(), fresh(g));
    assert.equal(codeOf(v, 'api-impl'), 'node_scope_changed', field);
    assert.ok(v.rejected.find(r => r.node === 'api-impl').fields.includes(field), field);
  }
  const red = GRAPH().map(n => (n.id === 'api-red' ? { ...n, redSpecs: [SPEC, { file: 'spec/api.test.mjs', name: 'second' }] } : n));
  const v = run(archived(), fresh(red));
  assert.equal(codeOf(v, 'api-red'), 'node_scope_changed');
  assert.equal(codeOf(v, 'api-impl'), 'dep_not_adopted');
  assert.deepEqual(v.red, {});
});

test('node definition compare covers every listed field, in any key order', () => {
  assert.deepEqual([...ADOPT_NODE_FIELDS].sort(), ['deps', 'evidence', 'id', 'modelTier', 'othersOwned', 'phase', 'promptFile', 'reads', 'redSpecs', 'resources', 'risk', 'role', 'writes'].sort());
  const reordered = GRAPH().map(n => (n.id === 'api-red' ? { ...n, redSpecs: [{ name: SPEC.name, file: SPEC.file }] } : n));
  assert.deepEqual(run(archived(), fresh(reordered)).adopted.length, 5, 'key order inside a spec object is not a scope change');
  const prompt = GRAPH().map(n => (n.id === 'web-ui' ? { ...n, promptFile: '/p/other.txt' } : n));
  assert.equal(codeOf(run(archived(), fresh(prompt)), 'web-ui'), 'node_scope_changed');
});

test('[D9] an archived node that is not done is never adopted, and its dependents follow', () => {
  const old = archived();
  old.nodes['web-state'].state = 'failed';
  const v = run(old, fresh());
  assert.equal(codeOf(v, 'web-state'), 'node_not_done');
  assert.equal(codeOf(v, 'web-ui'), 'dep_not_adopted');
  const gone = archived(GRAPH().filter(n => n.id !== 'web-red'));
  const w = run(gone, fresh());
  assert.equal(codeOf(w, 'web-red'), 'node_not_archived');
  assert.equal(codeOf(w, 'web-state'), 'dep_not_adopted');
});

test('fingerprints must cover exactly reads + writes: an empty or missing fps never passes vacuously', () => {
  for (const fps of [{}, null, { 'src/web-ui.txt': 'fp:src/web-ui.txt', extra: 'x' }]) {
    const old = archived();
    old.nodes['web-ui'].fps = fps;
    assert.equal(codeOf(run(old, fresh()), 'web-ui'), 'node_files_changed', JSON.stringify(fps));
  }
});

test('[D4] a RED spec edited after RED: adopt_red_unverified (judgment), RED not carried, dependents not adopted', () => {
  // the spec sits in api-red's writes, so the RED check must come before the fingerprint check (else node_files_changed and a re-dispatch)
  const v = run(archived(), fresh(), world({ changedFps: ['spec/api.test.mjs'], red: () => ({ changed: ['spec/api.test.mjs'], moved: false }) }));
  assert.equal(codeOf(v, 'api-red'), 'adopt_red_unverified');
  assert.ok(!v.adopted.includes('api-impl'), 'api-impl (it reads the spec) is not adopted');
  assert.deepEqual(v.red, {});
  assert.deepEqual(v.judgments.map(j => [j.code, j.node]), [['adopt_red_unverified', 'api-red']]);
  assert.match(v.judgments[0].reason, /spec\/api\.test\.mjs/);
});

test('[D5] a moved base: adopt_red_unverified (moved), RED not carried (13b re-verifies; 13a stops)', () => {
  const v = run(archived(), fresh(), world({ red: () => ({ changed: [], moved: true }) }));
  assert.equal(codeOf(v, 'api-red'), 'adopt_red_unverified');
  assert.equal(v.rejected.find(r => r.node === 'api-red').moved, true);
  assert.deepEqual(v.red, {});
  assert.deepEqual(v.judgments.map(j => j.code), ['adopt_red_unverified']);
});

test('RED evidence that cannot bind is never carried: missing, no base_commit, no digest for a spec, another runner or spec set', () => {
  const cases = {
    missing: (o) => { delete o.gates.red['api-red']; },
    no_base: (o) => { delete o.gates.red['api-red'].base_commit; },
    no_digest: (o) => { o.gates.red['api-red'].spec_digests = {}; },
    other_node: (o) => { o.gates.red['api-red'].node = 'web-red'; },
    other_specs: (o) => { o.gates.red['api-red'].specs = [{ file: 'spec/api.test.mjs', name: 'other' }]; },
    runner_changed: (o) => { o.config.testCommands = { unit: { cmd: 'node', args: ['--test', 'x'], format: 'tap' } }; },
    runner_gone: (o) => { o.gates.red['api-red'].command = 'nope'; },
    format: (o) => { o.gates.red['api-red'].format = 'jest-json'; },
  };
  for (const [name, edit] of Object.entries(cases)) {
    const old = archived();
    edit(old);
    let asked = 0;
    const v = run(old, fresh(), world({ red: () => { asked++; return null; } }));
    assert.equal(codeOf(v, 'api-red'), name === 'missing' ? 'adopt_red_missing' : 'adopt_red_unverified', name);
    assert.deepEqual(v.red, {}, name);
    assert.equal(v.judgments.length, 1, name);
    assert.equal(asked, 0, `${name}: redChanges is never asked about evidence that does not bind (it returns null on an empty digest set)`);
  }
});

test('[D7] the adoption window: only a run with no attempts, every node pending, no RED, freeze, review, repair or ADOPTED', () => {
  assert.equal(windowRefusal(fresh()), null);
  const cases = { attempts: (s) => s.attempts.push({}), node: (s) => { s.nodes['web-ui'].state = 'done'; }, red: (s) => { s.gates.red.x = {}; },
    red_invalid: (s) => { s.gates.red_invalid = { x: {} }; }, freeze: (s) => { s.freeze = { candidate: 'c' }; }, review: (s) => s.review_chain.push({}),
    repair: (s) => s.repairs.push({}), adopted: (s) => s.events.push({ seq: 1, type: 'ADOPTED' }) };
  for (const [name, edit] of Object.entries(cases)) { const s = fresh(); edit(s); assert.match(windowRefusal(s) ?? '', /./, name); }
  // after applying an adoption the window is spent
  const s = fresh();
  applyAdoption(s, { dir: '/a/run-1-1', manifest_sha256: 'sha256:m', state: archived() }, run(archived(), fresh()));
  assert.match(windowRefusal(s) ?? '', /./);
});

test('[D3] [D10] source refusals: plan digest, live attempts, semantics, units, unsupported policy', () => {
  assert.equal(sourceRefusal(archived(), fresh()), null);
  assert.equal(sourceRefusal(archived(), fresh(GRAPH(), { plan_digest: 'sha256:other' }))?.code, 'adopt_plan_mismatch');
  for (const status of ['intent', 'launched', 'running', 'unknown'])
    assert.equal(sourceRefusal(archived(GRAPH(), { attempts: [{ attempt_id: 'w', status }] }), fresh())?.code, 'adopt_source_live', status);
  assert.equal(sourceRefusal(archived(GRAPH(), { attempts: [{ attempt_id: 'w', status: 'exited' }] }), fresh())?.code, 'adopt_source_live', 'unretired (no quiesced) counts as live');
  assert.equal(sourceRefusal(archived(GRAPH(), { policy_version: 2 }), fresh())?.code, 'adopt_policy_mismatch', 'test kinds on one side only');
  assert.equal(sourceRefusal(archived(), fresh(GRAPH(), { policy_version: 5 })), null, 'pinnedBase alone is not a semantics mismatch (R3)');
  assert.equal(sourceRefusal(archived(GRAPH(), { policy_version: 7 }), fresh(GRAPH(), { policy_version: 3 })), null);
  assert.equal(sourceRefusal(archived(GRAPH(), { unit_checks: {} }), fresh())?.code, 'adopt_units_unsupported');
  assert.equal(sourceRefusal(archived(GRAPH().map(n => ({ ...n, unit: 'u' }))), fresh())?.code, 'adopt_units_unsupported');
  assert.throws(() => sourceRefusal(archived(GRAPH(), { policy_version: 99 }), fresh()), (e) => e.code === 'policy_version_unsupported');
});

test('applyAdoption: adopted nodes done with archived fps and provenance, RED carried verbatim, one ADOPTED note, judgments recorded', () => {
  const s = fresh(), old = archived();
  const v = run(old, s, world({ changedFps: ['src/web-ui.txt'] }));
  applyAdoption(s, { dir: '/a/run-1-1', manifest_sha256: 'sha256:m', state: old }, v);
  assert.equal(s.nodes['api-red'].state, 'done');
  assert.deepEqual(s.nodes['api-red'].fps, old.nodes['api-red'].fps);
  assert.deepEqual(s.nodes['api-red'].adopted, { run_id: 'run-1', archive: '/a/run-1-1', manifest_sha256: 'sha256:m' });
  assert.equal(s.nodes['web-ui'].state, 'pending');
  assert.equal(s.nodes['web-ui'].adopted, undefined);
  assert.equal(JSON.stringify(s.gates.red['api-red']), JSON.stringify(old.gates.red['api-red']));
  const ev = s.events.filter(e => e.type === 'ADOPTED');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].from_run, 'run-1');
  assert.deepEqual(ev[0].rejected, [{ node: 'web-ui', code: 'node_files_changed' }]);
  assert.deepEqual(ev[0].red_carried, ['api-red']);
});

test('retireRefusal: a LIVE, unknown or unretired attempt blocks retire; terminal quiesced attempts do not', () => {
  assert.equal(retireRefusal({ attempts: [{ attempt_id: 'a', status: 'exited', quiesced: true }] }), null);
  assert.equal(retireRefusal({}), null);
  for (const a of [{ status: 'running' }, { status: 'unknown' }, { status: 'exited' }]) assert.match(retireRefusal({ attempts: [{ attempt_id: 'a', ...a }] }) ?? '', /a/);
});

// ------------------------------------------------------------------ readArchive: containment and manifest

function archiveTree(t) {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'adopt-src-')));
  t.after(() => rmSync(top, { recursive: true, force: true }));
  const root = join(top, 'archive', 'T-1'), dir = join(root, 'run-1-1');
  mkdirSync(dir, { recursive: true });
  const state = Buffer.from(JSON.stringify(archived()));
  const log = Buffer.from('{"event":"GATE"}\n');
  writeFileSync(join(dir, 'state.json'), state);
  writeFileSync(join(dir, 'engine.jsonl'), log);
  const manifest = { ticket: 'T-1', run_id: 'run-1', archived_at: '2026-11-23T00:00:00.000Z', files: { 'state.json': sha(state), 'engine.jsonl': sha(log) } };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { top, root, dir, manifest };
}
const opts = (root) => ({ root, ticket: 'T-1', runId: 'run-2' });
const refusedWith = (code) => (e) => { assert.equal(e.code, code, e.message); return true; };

test('readArchive accepts a well-formed archive and returns the state and the manifest digest', (t) => {
  const { root, dir } = archiveTree(t);
  const a = readArchive(dir, opts(root));
  assert.equal(a.state.run_id, 'run-1');
  assert.equal(a.dir, dir);
  assert.equal(a.manifest_sha256, sha(readFileSync(join(dir, 'manifest.json'))));
});

test('[D11] readArchive: --from outside the ticket archive root is adopt_source_outside (plain path, symlink, sibling prefix, the root itself)', { skip: LINK_SKIP }, (t) => {
  const { top, root, dir } = archiveTree(t);
  const outside = join(top, 'elsewhere');
  cpSync(dir, outside, { recursive: true });
  assert.throws(() => readArchive(outside, opts(root)), refusedWith('adopt_source_outside'));
  symlinkSync(outside, join(root, 'run-1-9'));
  assert.throws(() => readArchive(join(root, 'run-1-9'), opts(root)), refusedWith('adopt_source_outside'));
  const sibling = join(top, 'archive', 'T-10', 'run-1-1');
  mkdirSync(join(top, 'archive', 'T-10'));
  cpSync(dir, sibling, { recursive: true });
  assert.throws(() => readArchive(sibling, opts(root)), refusedWith('adopt_source_outside'));
  assert.throws(() => readArchive(root, opts(root)), refusedWith('adopt_source_outside'));
  assert.throws(() => readArchive(join(root, 'missing'), opts(root)), refusedWith('adopt_source_outside'));
});

test('[D6] [AC3] readArchive: a corrupt manifest fails safe (adopt_archive_invalid)', (t) => {
  const { root, dir, manifest } = archiveTree(t);
  const put = (m) => writeFileSync(join(dir, 'manifest.json'), typeof m === 'string' ? m : JSON.stringify(m));
  const cases = {
    'wrong sha of the engine log': () => writeFileSync(join(dir, 'engine.jsonl'), '{"event":"FORGED"}\n'),
    'missing manifest': () => rmSync(join(dir, 'manifest.json')),
    'extra key': () => put({ ...manifest, extra: 1 }),
    'wrong ticket': () => put({ ...manifest, ticket: 'T-2' }),
    'run_id differs from the state': () => put({ ...manifest, run_id: 'run-9' }),
    'no state listed': () => put({ ...manifest, files: { 'engine.jsonl': manifest.files['engine.jsonl'] } }),
    'unknown file listed': () => put({ ...manifest, files: { ...manifest.files, '../x': 'sha256:0' } }),
    'not JSON': () => put('{'),
    'unparsable state': () => { writeFileSync(join(dir, 'state.json'), '{'); put({ ...manifest, files: { ...manifest.files, 'state.json': sha('{') } }); },
    'the adopting run itself': () => { const s = Buffer.from(JSON.stringify(archived(GRAPH(), { run_id: 'run-2' }))); writeFileSync(join(dir, 'state.json'), s);
      put({ ...manifest, run_id: 'run-2', files: { ...manifest.files, 'state.json': sha(s) } }); },
  };
  const pristine = Object.fromEntries(['state.json', 'engine.jsonl', 'manifest.json'].map(f => [f, readFileSync(join(dir, f))]));
  for (const [name, corrupt] of Object.entries(cases)) {
    for (const [f, b] of Object.entries(pristine)) writeFileSync(join(dir, f), b);
    corrupt();
    assert.throws(() => readArchive(dir, opts(root)), refusedWith('adopt_archive_invalid'), name);
  }
});

test('readArchive refuses a symlinked state file inside the archive', { skip: LINK_SKIP }, (t) => {
  const { top, root, dir } = archiveTree(t);
  writeFileSync(join(top, 'real-state.json'), readFileSync(join(dir, 'state.json')));
  rmSync(join(dir, 'state.json'));
  symlinkSync(join(top, 'real-state.json'), join(dir, 'state.json'));
  assert.throws(() => readArchive(dir, opts(root)), refusedWith('adopt_archive_invalid'));
});
