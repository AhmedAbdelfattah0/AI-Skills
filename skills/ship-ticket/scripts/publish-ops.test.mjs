/**
 * PR-6a acceptance (CONSOLIDATED §8 P3 "duplicate PR refusal and journal negatives with fake providers"; §14.4 #5 interrupted
 * publication). The supervisor, its journal, the durable launcher and the publication child are REAL; the remote is a REAL local
 * bare repository reached through a github.com URL (url.<bare>.insteadOf), so `git push`/`ls-remote` are real git; `gh` is a
 * fake on PATH (fake-gh.cjs, a JSON PR store) and a `git` shim on PATH logs every push/ls-remote ATTEMPT and can SIGKILL the
 * publication child right after an effect (a lost response). Crashes are real SIGKILLs. No network.
 * Counts are of ATTEMPTS (invocations logged by the fakes), never of resulting objects, so a replay cannot hide behind an
 * idempotent provider; the fake gh enforces A9 (one OPEN PR per head->base, INFERRED from GitHub) only where a test says so.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync, chmodSync, realpathSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tick } from './supervisor.mjs';
import { MAX_PROBES } from './supervisor-journal.mjs';
import { parseLsRemote, matchPrs, publishPreconditions, publishTarget, publishTitle, statusPaths } from './publish-ops.mjs';
import { pinBaseRecord, baseCandidate } from './engine-base-read.mjs';
import { makeWorld, worldDeps, opts, effects, journal, readState, writeState } from './supervisor.test-helper.mjs';
import { waitFor } from './test-wait.test-helper.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HELPER = join(HERE, 'supervisor.test-helper.mjs');
const SKIP = process.platform === 'win32' ? 'process groups, the durable launcher and the shell shims are POSIX here' : false;
const REAL_GIT = (SKIP ? '' : spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout?.trim()) || '/usr/bin/git';
const X = 'a'.repeat(64);
const IDENTITY = 'github.com/acme/widget';
const URL = 'https://github.com/acme/widget.git';
const live = (o) => o.state !== 'recorded';
const alive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// The git shim: every push/ls-remote ATTEMPT is logged; `pub.kill_after` = { push: n, 'ls-remote': n } SIGKILLs the parent
// (the publication child) right after the n-th such REAL command completed: the effect happened, its response is lost.
const GIT_SHIM = (realGit) => `#!${process.execPath}
'use strict';
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process');
const W = process.env.SUP_WORLD, a = process.argv.slice(2);
const sub = a.find((x) => !x.startsWith('-'));
const pub0 = W ? (JSON.parse(fs.readFileSync(path.join(W, 'world.json'), 'utf8')).pub || {}) : {};
if (W && (sub === 'push' || sub === 'ls-remote') && (pub0.fail || {})[sub]) {
  fs.appendFileSync(path.join(W, 'effects.jsonl'), JSON.stringify({ kind: 'git:' + sub, argv: a, status: 128, failed: true, pid: process.pid }) + '\\n');
  process.stderr.write('fatal: unable to access (fake outage)'); process.exit(128);
}
if (W && sub === 'push' && pub0.kill_before_push) { // the act marker is written, the push never runs: killed in between
  fs.appendFileSync(path.join(W, 'effects.jsonl'), JSON.stringify({ kind: 'git:push', argv: a, killed_before: true, pid: process.pid }) + '\\n');
  fs.writeFileSync(path.join(W, 'killed'), 'git:push:before'); process.kill(process.ppid, 'SIGKILL'); process.exit(137);
}
const r = spawnSync(${JSON.stringify(realGit)}, a, { stdio: ['inherit', 'pipe', 'pipe'] });
if (W && (sub === 'push' || sub === 'ls-remote')) {
  fs.appendFileSync(path.join(W, 'effects.jsonl'), JSON.stringify({ kind: 'git:' + sub, argv: a, status: r.status, pid: process.pid }) + '\\n');
  const pub = JSON.parse(fs.readFileSync(path.join(W, 'world.json'), 'utf8')).pub || {};
  const n = (pub.kill_after || {})[sub];
  if (n) { const f = path.join(W, 'hits-git-' + sub); const k = (fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0) + 1; fs.writeFileSync(f, String(k));
    if (k === n) { fs.writeFileSync(path.join(W, 'killed'), 'git:' + sub + ':' + n); process.kill(process.ppid, 'SIGKILL'); } }
}
process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exitCode = r.status ?? 1;
`;

// The fake gh: a JSON PR store (gh.json). `pr list` returns EVERY stored PR whatever --head says (the client filter is what is
// tested), minus the hidden ones; `pr create` appends one PR (head OID read from the bare remote) and prints its URL.
// pub: { a9: true (refuse a 2nd OPEN head->base), lost_create: true (SIGKILL the parent after creating), hide: k (hide a created
// PR from the next k lists), kill_after_list: n (SIGKILL the parent after the n-th list) }.
const FAKE_GH = (realGit) => `#!${process.execPath}
'use strict';
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process');
const W = process.env.SUP_WORLD, a = process.argv.slice(2);
const flag = (k) => { const i = a.indexOf('--' + k); if (i >= 0) return a[i + 1]; const e = a.find((x) => x.startsWith('--' + k + '=')); return e ? e.slice(k.length + 3) : undefined; };
const pub = JSON.parse(fs.readFileSync(path.join(W, 'world.json'), 'utf8')).pub || {};
const sf = path.join(W, 'gh.json');
const st = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, 'utf8')) : { prs: [], next: 100, hidden: {} };
const save = () => { fs.writeFileSync(sf + '.tmp', JSON.stringify(st)); fs.renameSync(sf + '.tmp', sf); };
const log = (e) => fs.appendFileSync(path.join(W, 'effects.jsonl'), JSON.stringify({ ...e, pid: process.pid }) + '\\n');
const [c1, c2] = a;
if (c1 !== 'pr') { process.stderr.write('fake gh: only pr list|create'); process.exit(2); }
if (c2 === 'list') {
  log({ kind: 'gh:list', argv: a });
  const out = st.prs.filter((p) => !(st.hidden[p.number] > 0));
  for (const k of Object.keys(st.hidden)) if (st.hidden[k] > 0) st.hidden[k] -= 1;
  save();
  process.stdout.write(JSON.stringify(out));
  if (pub.kill_after_list) { const f = path.join(W, 'hits-gh-list'); const k = (fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0) + 1; fs.writeFileSync(f, String(k));
    if (k === pub.kill_after_list) { fs.writeFileSync(path.join(W, 'killed'), 'gh:list:' + k); process.kill(process.ppid, 'SIGKILL'); } }
  process.exit(0);
}
if (c2 === 'create') {
  log({ kind: 'gh:create', argv: a });
  const [owner, name] = flag('repo').split('/').slice(-2), head = flag('head'), base = flag('base');
  if (pub.a9 && st.prs.some((p) => p.state === 'OPEN' && p.headRefName === head && p.baseRefName === base && !p.isCrossRepository)) { process.stderr.write('a pull request for branch already exists'); process.exit(1); }
  const ls = spawnSync(${JSON.stringify(realGit)}, ['ls-remote', path.join(W, 'remote.git'), 'refs/heads/' + head], { encoding: 'utf8' });
  const number = st.next++;
  const url = 'https://github.com/' + owner + '/' + name + '/pull/' + number;
  st.prs.push({ number, state: 'OPEN', headRefName: head, headRefOid: (ls.stdout.split('\\t')[0] || '').trim(), baseRefName: base,
    headRepository: { id: 'R1', name }, headRepositoryOwner: { id: 'O1', login: owner }, isCrossRepository: false, url, title: flag('title'),
    body: fs.readFileSync(flag('body-file'), 'utf8') });
  if (pub.hide) st.hidden[number] = pub.hide;
  save();
  if (pub.lost_create) { fs.writeFileSync(path.join(W, 'killed'), 'gh:create'); process.kill(process.ppid, 'SIGKILL'); }
  process.stdout.write(url + '\\n');
  process.exit(0);
}
process.exit(2);
`;

function sh(cwd, ...args) {
  const r = spawnSync(REAL_GIT, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * A wave of tickets (default T1) at owner_publish with `publication: pull_request` and real repositories: main (the merge base)
 * on ONE bare remote behind the github.com URL, each ticket its own work tree and branch feat/<key> with the SHIP commit (unless
 * `commit: false`). The reviewed candidate X is the ENGINE'S candidate id (baseCandidate) of that content. `drift: true` then
 * commits DIFFERENT content after X was taken (a concurrent amend). Returns T1's { wt, commit, X } at top level plus `tickets`.
 */
function pubWorld(t, { keys = ['T1'], publication = 'pull_request', merge_strategy, commit = true, drift = false, title = 'Widget: add a', pub = {}, prs = [], state = {} } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pub-')));
  t.after(() => { killWorld(dir); rmSync(dir, { recursive: true, force: true }); });
  makeWorld(dir, keys.map((key) => ({ key, phase: 'published' })), { publication: publication ?? undefined, merge_strategy });
  const bare = join(dir, 'remote.git');
  sh(dir, 'init', '-q', '--bare', '-b', 'main', bare);
  const seedDir = join(dir, 'seed');
  sh(dir, 'init', '-q', '-b', 'main', seedDir);
  for (const [k, v] of [['user.name', 't'], ['user.email', 't@example.com'], ['commit.gpgsign', 'false']]) sh(seedDir, 'config', k, v);
  writeFileSync(join(seedDir, 'README.md'), 'base\n');
  sh(seedDir, 'add', '-A'); sh(seedDir, 'commit', '-q', '-m', 'base');
  sh(seedDir, 'push', '-q', bare, 'main');
  const base = sh(seedDir, 'rev-parse', 'HEAD');
  const tickets = {};
  for (const key of keys) {
    const wt = join(dir, 'wt', key);
    sh(dir, 'clone', '-q', bare, wt);
    for (const [k, v] of [['user.name', 't'], ['user.email', 't@example.com'], ['commit.gpgsign', 'false'], [`url.${bare}.insteadOf`, URL]]) sh(wt, 'config', k, v);
    sh(wt, 'remote', 'set-url', 'origin', URL);
    sh(wt, 'checkout', '-q', '-b', `feat/${key}`);
    mkdirSync(join(wt, 'src'), { recursive: true });
    mkdirSync(join(wt, '.specs', 'plans'), { recursive: true });
    writeFileSync(join(wt, 'src', `${key}.txt`), `the candidate of ${key}\n`);
    writeFileSync(join(wt, '.specs', 'plans', `${key}.md`), `# ${title}\n\nthe plan\n`);
    const mb = { remote: 'origin', identity: IDENTITY, ref: 'main', sha: base, merge_base: base };
    const exclusions = [`.specs/plans/${key}.md`, 'session-log.md'];
    const cs = { config: { pinnedBase: { remote: 'origin' }, base: 'main' }, base: mb };
    const X = baseCandidate(wt, cs, exclusions).candidate_id;
    assert.match(X, /^[0-9a-f]{64}$/, 'the engine candidate of the reviewed content');
    let head = base;
    if (commit) { sh(wt, 'add', '-A'); sh(wt, 'commit', '-q', '-m', `${key}: the SHIP commit`); head = sh(wt, 'rev-parse', 'HEAD'); }
    if (drift) { writeFileSync(join(wt, 'src', `${key}.txt`), 'UNREVIEWED content\n'); sh(wt, 'commit', '-q', '-a', '--amend', '-m', `${key}: amended`); head = sh(wt, 'rev-parse', 'HEAD'); }
    const S = readState(dir, key);
    writeState(dir, key, { ...S, seq: 9, events: [{ seq: 8, type: 'GATE', gate: 'ship-ready', ok: true, code: 'ship_ready' }],
      config: { ...S.config, pinnedBase: { remote: 'origin' }, base: 'main' }, pinned_exclusions: exclusions,
      review_chain: [{ review_execution: 'rx-1', kind: 'original', outcome: 'PASS', candidate_id: X }],
      freeze: { candidate: X, base: mb, seq: 6 }, local_proof: { candidate_id: X }, ship_ready: { candidate_id: X, seq: 8, base: mb },
      base: { ...mb, pinned_at_seq: 1 }, ...state });
    tickets[key] = { wt, commit: head, X };
  }
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), GIT_SHIM(REAL_GIT)); chmodSync(join(bin, 'git'), 0o755);
  writeFileSync(join(bin, 'gh'), FAKE_GH(REAL_GIT)); chmodSync(join(bin, 'gh'), 0o755);
  const head1 = tickets[keys[0]].commit;
  writeFileSync(join(dir, 'gh.json'), JSON.stringify({ prs: prs.map((p) => ({ headRepository: { id: 'R1', name: 'widget' }, headRepositoryOwner: { id: 'O1', login: 'acme' }, isCrossRepository: false, baseRefName: 'main', url: `https://github.com/acme/widget/pull/${p.number}`, ...p, headRefOid: p.headRefOid === 'HEAD' ? head1 : p.headRefOid })), next: 100, hidden: {} }));
  const w = JSON.parse(readFileSync(join(dir, 'world.json'), 'utf8'));
  writeFileSync(join(dir, 'world.json'), JSON.stringify({ ...w, pub }));
  return { dir, bare, base, tickets, ...tickets[keys[0]] };
}

function killWorld(dir) {
  try { for (const o of Object.values(journal(dir)?.ops ?? {})) if (o.pgid) try { process.kill(-o.pgid, 'SIGKILL'); } catch { /* gone */ } } catch { /* no journal */ }
}
async function waitLive(dir) {
  const J = journal(dir);
  if (!J) return;
  for (const o of Object.values(J.ops)) if (o.kind === 'launch' && live(o) && o.pgid) await waitFor(() => existsSync(o.files.envelope) || !alive(o.pgid), `op ${o.op_id}`);
}
async function settleAll(dir, over = {}, max = 40) {
  let last = '';
  for (let i = 0; i < max; i++) {
    await waitLive(dir);
    await tick(opts(dir), worldDeps(dir, over));
    await waitLive(dir);
    const J = journal(dir);
    const sig = JSON.stringify([Object.values(J?.ops ?? {}).map((o) => [o.op_id, o.state, o.probes]), J?.blocked, J?.ship_ready, effects(dir).length]);
    if (sig === last) return J;
    last = sig;
  }
  throw new Error('world did not settle');
}
async function runTicks(dir, n, over = {}) {
  for (let i = 0; i < n; i++) { await waitLive(dir); await tick(opts(dir), worldDeps(dir, over)); }
  await waitLive(dir);
  return journal(dir);
}
const count = (dir, kind) => effects(dir).filter((e) => e.kind === kind).length;
const pushes = (dir) => effects(dir).filter((e) => e.kind === 'git:push');
const ghState = (dir) => JSON.parse(readFileSync(join(dir, 'gh.json'), 'utf8'));
const remoteRef = (bare, ref) => spawnSync(REAL_GIT, ['--git-dir', bare, 'rev-parse', '--verify', '--quiet', ref], { encoding: 'utf8' }).stdout.trim() || null;
const child = (dir, spec) => spawnSync(process.execPath, [HELPER, 'tick', dir, ...(spec ? [spec] : [])], { encoding: 'utf8', timeout: 60000, env: { ...process.env, SUP_WORLD: dir } });

// ------------------------------------------------------------------------------------------------- pure parts

test('pure: ls-remote is read for the EXACT ref; PR adoption needs repo, head, base, OPEN and the number or the pushed OID', () => {
  const oid = 'b'.repeat(40), other = 'c'.repeat(40);
  assert.deepEqual(parseLsRemote(`${oid}\trefs/heads/feat/T1\n`, 'refs/heads/feat/T1'), { state: 'present', oid });
  assert.deepEqual(parseLsRemote('', 'refs/heads/feat/T1'), { state: 'absent' });
  assert.deepEqual(parseLsRemote(`${other}\trefs/heads/x/refs/heads/feat/T1\n`, 'refs/heads/feat/T1'), { state: 'absent' }, 'a tail match of another ref is not the ref');
  assert.deepEqual(parseLsRemote('garbage\n', 'refs/heads/feat/T1'), { state: 'invalid' });
  const T = { owner: 'acme', repo: 'widget', head: 'feat/T1', base: 'main', oid };
  const pr = (o) => ({ number: 1, state: 'OPEN', headRefName: 'feat/T1', headRefOid: oid, baseRefName: 'main', headRepository: { name: 'widget' }, headRepositoryOwner: { login: 'acme' }, isCrossRepository: false, ...o });
  assert.deepEqual(matchPrs([pr()], T), { kind: 'one', pr: { number: 1, url: null } });
  assert.equal(matchPrs([pr({ headRepositoryOwner: { login: 'ACME' } })], T).kind, 'one', 'GitHub names are case-insensitive');
  for (const [o, why] of [[{ headRefName: 'feat/OTHER' }, 'another head'], [{ baseRefName: 'release' }, 'another base'], [{ state: 'CLOSED' }, 'a stale closed PR'],
    [{ state: 'MERGED' }, 'merged'], [{ isCrossRepository: true }, 'a fork'], [{ headRepositoryOwner: { login: 'evil' } }, 'another owner'], [{ headRepository: { name: 'w2' } }, 'another repo']])
    assert.equal(matchPrs([pr(o)], T).kind, 'none', why);
  assert.equal(matchPrs([pr({ headRefOid: other })], T).kind, 'conflict', 'an OPEN same head/base PR on another OID is never adopted');
  assert.equal(matchPrs([pr({ headRefOid: other, number: 5 })], { ...T, number: 5 }).kind, 'one', 'the recorded number adopts');
  assert.deepEqual(matchPrs([pr(), pr({ number: 2 })], T), { kind: 'many', prs: [1, 2] });
  assert.deepEqual(statusPaths(' M a.txt\0?? b c.txt\0R  new.txt\0old.txt\0'), ['a.txt', 'b c.txt', 'new.txt', 'old.txt']);
  assert.equal(publishTitle('# T1 add $(rm -rf /)\u0007\n', 'T1'), 'T1 add $(rm -rf /)');
  assert.equal(publishTitle('no heading', 'T1'), 'T1');
});

test('pure: no publication before exact-candidate review PASS and SHIP_READY on the same candidate (publish_preconditions_unmet)', () => {
  const ok = { ship_ready: { candidate_id: X, seq: 8 }, freeze: { candidate: X }, local_proof: { candidate_id: X }, review_chain: [{ kind: 'original', outcome: 'PASS', candidate_id: X }] };
  const n = { action: 'stop', code: 'owner_publish' };
  assert.equal(publishPreconditions(ok, n).ok, true);
  const Y = 'd'.repeat(64);
  for (const [S, nn, why] of [[ok, { action: 'stop', code: 'ship_ready_stale' }, 'next is not owner_publish'],
    [{ ...ok, review_chain: [{ kind: 'original', outcome: 'FAIL', candidate_id: X }] }, n, 'latest review FAIL'],
    [{ ...ok, review_chain: [...ok.review_chain, { kind: 'repair' }] }, n, 'a repair after the PASS'],
    [{ ...ok, review_chain: [{ kind: 'original', outcome: 'PASS', candidate_id: Y }] }, n, 'PASS of another candidate'],
    [{ ...ok, freeze: { candidate: Y } }, n, 'freeze of another candidate'], [{ ...ok, local_proof: { candidate_id: Y } }, n, 'local proof of another'],
    [{ ...ok, ship_ready: undefined }, n, 'no SHIP_READY'], [{ ...ok, events: [{ type: 'GATE', gate: 'ship-ready', ok: false }] }, n, 'the last ship-ready refused']])
    assert.equal(publishPreconditions(S, nn).ok, false, why);
});

test('source: publication never forces, never merges, never runs a shell; no tags or submodules ride the push; gh is host-pinned', () => {
  const src = readFileSync(join(HERE, 'publish-ops.mjs'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join('\n');
  for (const bad of ["'--force'", "'-f'", 'force-with-lease', "'--force-with-lease", "'merge'", 'shell: true', 'execSync', "'deploy'", 'appendFileSync'])
    assert.ok(!code.includes(bad), `publish-ops has no ${bad}`);
  assert.ok(!/`\+\$\{/.test(code) && !/'\+refs/.test(code), 'no + (forced) refspec');
  assert.ok(/`\$\{s\.oid\}:refs\/heads\/\$\{s\.branch\}`/.test(code), 'the push refspec is the exact OID to the exact ref');
  assert.ok(code.includes('`--title=${s.title}`') && code.includes("'--body-file'"), 'the title is one argv element; the body a file');
  assert.ok(code.includes("'--no-follow-tags', '--recurse-submodules=no'"), 'tags and submodules never ride the push');
  assert.equal((code.match(/'--repo', `github\.com\/\$\{s\.owner\}\/\$\{s\.repo\}`/g) ?? []).length, 2, 'gh list and create name the host: GH_HOST cannot redirect');
  const sup = readFileSync(join(HERE, 'supervisor.mjs'), 'utf8');
  assert.ok(!/localHead|authGit|spawnSync\(\s*'git'/.test(sup.slice(sup.indexOf('async function stepTicket'), sup.indexOf('// ---------------------------------------------------------------------------------------------------- tick'))), 'no git under the journal lock in stepTicket');
});

// ------------------------------------------------------------------------------------------------- happy path

test('Owner Merge + publication: adopt the SHIP commit, push it once (non-force), open ONE PR; never merged; later ticks add nothing', { skip: SKIP }, async (t) => {
  const w = pubWorld(t);
  const J = await settleAll(w.dir);
  assert.deepEqual(J.blocked, {});
  const P = J.ship_ready.T1;
  assert.equal(P.merge, 'awaiting_owner_merge');
  assert.equal(P.publication.commit, w.commit);
  assert.deepEqual(P.publication.pushed, { remote: 'origin', ref: 'refs/heads/feat/T1', oid: w.commit });
  assert.equal(P.publication.pr.number, 100);
  assert.equal(P.publication.candidate, w.X);
  assert.equal(remoteRef(w.bare, 'refs/heads/feat/T1'), w.commit, 'the remote branch is the exact commit');
  const [push] = pushes(w.dir);
  assert.equal(pushes(w.dir).length, 1);
  assert.deepEqual(push.argv.slice(-4), ['--no-follow-tags', '--recurse-submodules=no', 'origin', `${w.commit}:refs/heads/feat/T1`]);
  assert.ok(push.argv.includes(`${w.commit}:refs/heads/feat/T1`) && !push.argv.some((a) => /^(-f|--force.*|\+.*)$/.test(a)), `non-force exact refspec: ${push.argv}`);
  const creates = effects(w.dir).filter((e) => e.kind === 'gh:create');
  assert.equal(creates.length, 1);
  assert.ok(creates[0].argv.includes('--title=T1: Widget: add a'), creates[0].argv.join(' '));
  assert.deepEqual(ghState(w.dir).prs.map((p) => [p.number, p.headRefName, p.baseRefName, p.headRefOid]), [[100, 'feat/T1', 'main', w.commit]]);
  const n = effects(w.dir).length;
  await settleAll(w.dir);
  assert.equal(effects(w.dir).length, n, 'idempotent: later ticks add no effect and no probe');
  assert.ok(!effects(w.dir).some((e) => (e.argv ?? []).includes('merge')), 'nothing merges');
  // the journal carries the exact-head binding of every op
  const ops = Object.values(J.ops);
  assert.deepEqual(ops.map((o) => o.op).sort(), ['commit', 'pr', 'push']);
  assert.ok(ops.every((o) => o.op_id.endsWith(`:c${w.X}`)), 'every op id is fixed by the candidate');
  // the FULL target identity is in the journal intent record itself (not only in a sidecar file)
  const byOp = Object.fromEntries(ops.map((o) => [o.op, o]));
  assert.deepEqual([byOp.commit.result.commit, byOp.commit.result.parent, byOp.commit.result.candidate, byOp.commit.publish_spec.candidate], [w.commit, w.base, w.X, w.X]);
  const ps = byOp.push.publish_spec, rs = byOp.pr.publish_spec;
  assert.deepEqual([ps.remote, ps.identity, ps.branch, ps.oid, ps.candidate, ps.ship_ready_seq], ['origin', IDENTITY, 'feat/T1', w.commit, w.X, 8]);
  assert.deepEqual(byOp.push.publish_spec.exclusions, ['.specs/plans/T1.md', 'session-log.md'], 'exactly S.pinned_exclusions: no manifest plan path or session log is added');
  assert.deepEqual([rs.owner, rs.repo, rs.branch, rs.base, rs.oid, rs.title, rs.identity], ['acme', 'widget', 'feat/T1', 'main', w.commit, 'T1: Widget: add a', IDENTITY]);
});

test('reachability: a ticket the ENGINE reports ship_ready (SHIP_READY in RUN-STATE) is still published; without publication it is not stepped', { skip: SKIP }, async (t) => {
  const engineShipReady = { readTicket: () => ({ state: 'ship_ready', reason: 'ship_ready' }) };
  const w = pubWorld(t);
  const J = await settleAll(w.dir, engineShipReady);
  assert.equal(J.ship_ready.T1.publication.pr.number, 100);
  assert.equal(pushes(w.dir).length, 1);
  const b = pubWorld(t, { publication: null });
  const Jb = await settleAll(b.dir, engineShipReady);
  assert.equal(Jb.ship_ready.T1, undefined, 'PR-5 behaviour unchanged: an engine-ship_ready ticket is not stepped');
  assert.equal(effects(b.dir).length, 0);
});

test('the REAL pinned-base record (pinBaseRecord: remote NAME, lower-cased github identity) is a publication target', { skip: SKIP }, (t) => {
  const w = pubWorld(t);
  sh(w.wt, 'fetch', '-q', 'origin');
  sh(w.wt, 'branch', '--set-upstream-to=origin/main');
  const pin = pinBaseRecord(w.wt, { pinnedBase: { remote: 'origin' }, base: 'main' });
  assert.deepEqual([pin.base.remote, pin.base.identity, pin.base.ref, pin.base.merge_base], ['origin', IDENTITY, 'main', w.base]);
  const T = publishTarget({ base: { ...pin.base, pinned_at_seq: 1 }, ship_ready: { candidate_id: X, seq: 8, base: pin.base } }, { branch: 'feat/T1' });
  assert.deepEqual([T.ok, T.remote, T.identity, T.owner, T.repo, T.base, T.merge_base], [true, 'origin', IDENTITY, 'acme', 'widget', 'main', w.base]);
});

test('Automatic Merge + publication: published, the merge is prevented (PR-6b); publication absent: the PR-5 handoff, zero git/gh effects', { skip: SKIP }, async (t) => {
  const a = pubWorld(t, { merge_strategy: 'automatic' });
  const Ja = await settleAll(a.dir);
  assert.match(Ja.ship_ready.T1.merge, /^prevented: merge executor not implemented/);
  assert.equal(Ja.ship_ready.T1.publication.pr.number, 100);
  const b = pubWorld(t, { publication: null });
  const Jb = await settleAll(b.dir);
  assert.equal(Jb.ship_ready.T1.merge, 'awaiting_owner_merge');
  assert.equal(Jb.ship_ready.T1.publication, undefined);
  assert.equal(Jb.binding.publication, 'none');
  assert.equal(effects(b.dir).filter((e) => /^(git|gh):/.test(e.kind)).length, 0, 'no publication effect at all');
  assert.equal(remoteRef(b.bare, 'refs/heads/feat/T1'), null);
  // a publication change mid-wave is a plan change (refused)
  const manifest = JSON.parse(readFileSync(join(b.dir, 'manifest.json'), 'utf8'));
  const r = await tick(opts(b.dir), worldDeps(b.dir, { readManifest: () => ({ ok: true, manifest: { ...manifest, publication: 'pull_request' }, digest: worldDeps(b.dir).verifyWave().digest }) }));
  assert.equal(r.code, 2);
  assert.equal(r.out.code, 'wave_plan_changed');
});

// ------------------------------------------------------------------------------------------------- refusals

test('no commit yet: parked awaiting_commit (never a blind commit), then adopted once the SHIP commit exists', { skip: SKIP }, async (t) => {
  const w = pubWorld(t, { commit: false });
  const J = await runTicks(w.dir, 6);
  assert.deepEqual(J.blocked, {});
  assert.equal(J.ship_ready.T1, undefined);
  const ops = Object.values(J.ops);
  assert.ok(ops.filter((o) => o.result).length >= 3 && ops.every((o) => o.op === 'commit' && (!o.result || (o.result.outcome === 'parked' && o.result.code === 'awaiting_commit'))), JSON.stringify(ops.map((o) => [o.op, o.result])));
  assert.equal(sh(w.wt, 'rev-parse', 'HEAD'), w.base, 'HEAD untouched: the supervisor never creates the commit');
  assert.equal(pushes(w.dir).length, 0);
  sh(w.wt, 'add', '-A'); sh(w.wt, 'commit', '-q', '-m', 'T1: the SHIP commit');
  const J2 = await settleAll(w.dir);
  assert.equal(J2.ship_ready.T1.publication.commit, sh(w.wt, 'rev-parse', 'HEAD'));
  assert.equal(pushes(w.dir).length, 1);
});

test('publication before exact-candidate review PASS + SHIP_READY is refused: publish_preconditions_unmet, zero push or PR', { skip: SKIP }, async (t) => {
  const w = pubWorld(t, { state: { review_chain: [{ review_execution: 'rx-1', kind: 'original', outcome: 'PASS', candidate_id: 'e'.repeat(64) }] } });
  const J = await settleAll(w.dir);
  assert.equal(J.blocked.T1.code, 'publish_preconditions_unmet');
  assert.equal(effects(w.dir).filter((e) => /^(git|gh):/.test(e.kind)).length, 0);
  assert.equal(Object.keys(J.ops).length, 0);
  const u = pubWorld(t, { state: { base: undefined } });
  assert.equal((await settleAll(u.dir)).blocked.T1.code, 'publish_target_unbound', 'an identity-unbound run is never published');
});

test('a diverged remote branch is Blocked push_requires_force: no push attempt at all, the remote ref untouched', { skip: SKIP }, async (t) => {
  const w = pubWorld(t);
  // someone else's commit already on the remote ticket branch
  const other = join(w.dir, 'other');
  sh(w.dir, 'clone', '-q', w.bare, other);
  for (const [k, v] of [['user.name', 'o'], ['user.email', 'o@example.com']]) sh(other, 'config', k, v);
  sh(other, 'checkout', '-q', '-b', 'feat/T1'); writeFileSync(join(other, 'x.txt'), 'x'); sh(other, 'add', '-A'); sh(other, 'commit', '-q', '-m', 'x'); sh(other, 'push', '-q', 'origin', 'feat/T1');
  const theirs = remoteRef(w.bare, 'refs/heads/feat/T1');
  const J = await settleAll(w.dir);
  assert.equal(J.blocked.T1.code, 'push_requires_force');
  assert.match(J.blocked.T1.reason, /non-force push cannot publish it/);
  assert.equal(pushes(w.dir).length, 0, 'never attempted, so never forced');
  assert.equal(remoteRef(w.bare, 'refs/heads/feat/T1'), theirs);
  assert.equal(count(w.dir, 'gh:create'), 0);
});

test('PR adoption: unrelated heads, a stale CLOSED PR of the same OID, another base and a fork are never adopted; ONE create', { skip: SKIP }, async (t) => {
  const w = pubWorld(t, { prs: [
    { number: 7, state: 'OPEN', headRefName: 'feat/OTHER', headRefOid: 'HEAD' },
    { number: 8, state: 'CLOSED', headRefName: 'feat/T1', headRefOid: 'HEAD' },
    { number: 9, state: 'OPEN', headRefName: 'feat/T1', baseRefName: 'release', headRefOid: 'HEAD' },
    { number: 10, state: 'OPEN', headRefName: 'feat/T1', headRefOid: 'HEAD', isCrossRepository: true, headRepositoryOwner: { login: 'fork' } }] });
  const J = await settleAll(w.dir);
  assert.equal(J.ship_ready.T1.publication.pr.number, 100, 'the new PR, none of the listed ones');
  assert.equal(count(w.dir, 'gh:create'), 1);
});

test('several matching OPEN PRs are refused (pr_multiple_matches); an OPEN same head/base PR on another OID is pr_conflict_open; 0 creates', { skip: SKIP }, async (t) => {
  const m = pubWorld(t, { prs: [{ number: 7, state: 'OPEN', headRefName: 'feat/T1', headRefOid: 'HEAD' }, { number: 8, state: 'OPEN', headRefName: 'feat/T1', headRefOid: 'HEAD' }] });
  const Jm = await settleAll(m.dir);
  assert.equal(Jm.blocked.T1.code, 'pr_multiple_matches');
  assert.equal(count(m.dir, 'gh:create'), 0);
  const c = pubWorld(t, { prs: [{ number: 7, state: 'OPEN', headRefName: 'feat/T1', headRefOid: 'f'.repeat(40) }] });
  const Jc = await settleAll(c.dir);
  assert.equal(Jc.blocked.T1.code, 'pr_conflict_open');
  assert.equal(count(c.dir, 'gh:create'), 0);
  const one = pubWorld(t, { prs: [{ number: 7, state: 'OPEN', headRefName: 'feat/T1', headRefOid: 'HEAD' }] });
  const Jo = await settleAll(one.dir);
  assert.equal(Jo.ship_ready.T1.publication.pr.number, 7, 'exactly one matching OPEN PR is adopted');
  assert.equal(count(one.dir, 'gh:create'), 0);
});

// ------------------------------------------------------------------------------------------------- lost responses

test('a lost response after PR create never creates a second PR: the op is ambiguous, a read-only probe adopts it (A9 off)', { skip: SKIP }, async (t) => {
  const w = pubWorld(t, { pub: { lost_create: true } });
  const J = await settleAll(w.dir);
  assert.equal(count(w.dir, 'gh:create'), 1, 'one create attempt');
  assert.equal(J.ship_ready.T1.publication.pr.number, 100);
  const pr = Object.values(J.ops).find((o) => o.op === 'pr');
  assert.equal(pr.result.how, 'probe', 'adopted by the direct-object probe, not re-created');
  assert.ok(Object.values(J.ops).some((o) => o.op === 'pr.probe' && o.probe_of === pr.op_id));
  // the same with the provider enforcing A9 (one OPEN PR per head->base): still one attempt, adopted
  const a9 = pubWorld(t, { pub: { lost_create: true, a9: true } });
  assert.equal((await settleAll(a9.dir)).ship_ready.T1.publication.pr.number, 100);
  assert.equal(count(a9.dir, 'gh:create'), 1);
});

test('delayed visibility after a lost create: the list miss is NOT proof; bounded probes, the op stays ambiguous, ticket alone Blocked', { skip: SKIP }, async (t) => {
  const w = pubWorld(t, { pub: { lost_create: true, hide: 99 } });
  const J = await settleAll(w.dir);
  assert.equal(count(w.dir, 'gh:create'), 1, 'never a second create');
  assert.equal(J.blocked.T1.code, 'ambiguous_unresolved');
  const pr = J.ops[J.blocked.T1.op_id];
  assert.equal(pr.op, 'pr');
  assert.equal(pr.state, 'ambiguous');
  assert.equal(pr.probes, MAX_PROBES);
  assert.equal(Object.values(J.ops).filter((o) => o.op === 'pr.probe').length, MAX_PROBES, 'bounded re-probes');
  const n = effects(w.dir).length;
  await settleAll(w.dir);
  assert.equal(effects(w.dir).length, n, 'a spent ambiguous op is never probed or replayed again');
});

test('a lost response after the push (the effect landed, the child died): ambiguous, probed, adopted; one push attempt', { skip: SKIP }, async (t) => {
  const w = pubWorld(t, { pub: { kill_after: { push: 1 } } });
  const J = await settleAll(w.dir);
  assert.equal(pushes(w.dir).length, 1);
  const push = Object.values(J.ops).find((o) => o.op === 'push');
  assert.equal(push.result.how, 'probe');
  assert.equal(J.ship_ready.T1.publication.pushed.oid, w.commit);
});

// ------------------------------------------------------------------------------------------------- crash matrix

const SUP_BOUNDARIES = ['after-tick-start', 'after-intent', 'after-commit-record', 'after-receipt', 'after-pid', 'after-release', 'after-acted'];
const CHILD_KILLS = [{ kill_after: { 'ls-remote': 1 } }, { kill_after: { 'ls-remote': 2 } }, { kill_after: { push: 1 } }, { kill_after: { 'ls-remote': 3 } }, { kill_after_list: 1 }, { kill_after_list: 2 }, { lost_create: true }, { lost_create: true, a9: true }];
function verdict(w, J, label) {
  assert.ok(pushes(w.dir).length <= 1, `${label}: ${pushes(w.dir).length} push attempts`);
  assert.ok(count(w.dir, 'gh:create') <= 1, `${label}: ${count(w.dir, 'gh:create')} create attempts`);
  assert.ok(ghState(w.dir).prs.length <= 1, `${label}: ${ghState(w.dir).prs.length} PRs`);
  if (J.ship_ready.T1?.publication) {
    assert.equal(remoteRef(w.bare, 'refs/heads/feat/T1'), w.commit, label);
    assert.equal(J.ship_ready.T1.publication.pr.number, ghState(w.dir).prs[0].number, label);
    return 'published';
  }
  assert.equal(J.blocked.T1?.code, 'ambiguous_unresolved', `${label}: ${JSON.stringify(J.blocked.T1 ?? J.ship_ready.T1)}`);
  assert.equal(J.ops[J.blocked.T1.op_id].state, 'ambiguous', `${label}: the uncertain op is preserved, never replayed`);
  return 'ambiguous';
}
test('kill -9 at every hit of every boundary (supervisor and inside the publication child): <= 1 push and PR attempt, or preserved ambiguous', { skip: SKIP, timeout: 900000 }, async (t) => {
  const landed = {}, ends = {};
  for (const b of SUP_BOUNDARIES) {
    for (let n = 1; ; n++) {
      const w = pubWorld(t);
      let killed = false;
      for (let i = 0; i < 20 && !killed; i++) {
        await waitLive(w.dir);
        const r = child(w.dir, `${b}:${n} kill`);
        killed = r.signal === 'SIGKILL';
        assert.ok(killed || r.status === 0, `${b}:${n}: ${r.status} ${r.stderr}`);
        const J = journal(w.dir);
        if (!killed && J && (J.ship_ready.T1 || J.blocked.T1) && !Object.values(J.ops).some(live)) break;
      }
      if (!killed) { assert.ok(n > 1, `${b} is never reached`); landed[b] = n - 1; break; }
      const v = verdict(w, await settleAll(w.dir), `${b}:${n}`);
      ends[v] = (ends[v] ?? 0) + 1;
    }
  }
  for (const pub of CHILD_KILLS) {
    const w = pubWorld(t, { pub });
    const J = await settleAll(w.dir);
    assert.ok(existsSync(join(w.dir, 'killed')), `the child kill ${JSON.stringify(pub)} landed`);
    const v = verdict(w, J, JSON.stringify(pub));
    ends[v] = (ends[v] ?? 0) + 1;
  }
  for (const b of SUP_BOUNDARIES) assert.ok(landed[b] >= 1, `${b}: ${landed[b]}`);
  t.diagnostic(`supervisor kills per boundary: ${JSON.stringify(landed)}; ends: ${JSON.stringify(ends)}`);
});

test('two resumers at once cannot both act (one journal lock): exactly one push and one PR', { skip: SKIP, timeout: 120000 }, async (t) => {
  const w = pubWorld(t);
  for (let round = 0; round < 8; round++) {
    await waitLive(w.dir);
    const both = await Promise.all([0, 1].map(() => new Promise((res) => {
      const c = spawn(process.execPath, [HELPER, 'tick', w.dir], { env: { ...process.env, SUP_WORLD: w.dir }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; c.stdout.on('data', (d) => { out += d; }); c.on('exit', (code) => res({ code, out }));
    })));
    for (const r of both) assert.equal(r.code, 0, r.out);
  }
  const J = await settleAll(w.dir);
  assert.equal(J.ship_ready.T1.publication.pr.number, 100);
  assert.equal(pushes(w.dir).length, 1);
  assert.equal(count(w.dir, 'gh:create'), 1);
});

test('candidate-generated text never reaches a shell: a plan heading with $(...) and backticks is one --title argv element', { skip: SKIP }, async (t) => {
  const evil = 'T1 $(touch PWNED) `touch PWNED2`; touch PWNED3 && echo "x"';
  const w = pubWorld(t, { title: evil });
  const J = await settleAll(w.dir);
  assert.ok(J.ship_ready.T1.publication);
  for (const f of ['PWNED', 'PWNED2', 'PWNED3']) for (const d of [w.wt, w.dir, process.cwd()]) assert.ok(!existsSync(join(d, f)), `${f} in ${d}`);
  const create = effects(w.dir).find((e) => e.kind === 'gh:create');
  assert.ok(create.argv.includes(`--title=${evil}`), create.argv.join(' | '));
  assert.equal(ghState(w.dir).prs[0].title, evil);
});

// ------------------------------------------------------------------------------------------------- round 1 repair

test('content binding: a commit of DIFFERENT content after the review is never published (publish_candidate_mismatch, 0 push)', { skip: SKIP }, async (t) => {
  const w = pubWorld(t, { drift: true });
  const J = await settleAll(w.dir);
  assert.equal(J.blocked.T1.code, 'publish_candidate_mismatch');
  assert.match(J.blocked.T1.reason, /unreviewed content is never published/);
  assert.equal(pushes(w.dir).length, 0);
  assert.equal(count(w.dir, 'git:ls-remote'), 0, 'refused before any remote is contacted');
  assert.equal(remoteRef(w.bare, 'refs/heads/feat/T1'), null);
});

test('content binding: an amend between the commit adoption and the push child is refused in the child, never pushed', { skip: SKIP }, async (t) => {
  const w = pubWorld(t);
  let amended = false;
  const hooks = { boundary: async (b) => {
    if (b !== 'after-commit-record' || amended) return;
    amended = true;
    writeFileSync(join(w.wt, 'src', 'T1.txt'), 'UNREVIEWED content\n');
    sh(w.wt, 'commit', '-q', '-a', '--amend', '-m', 'T1: amended');
  } };
  const J = await settleAll(w.dir, { hooks });
  assert.ok(amended, 'the amend landed right after the adoption was recorded');
  assert.equal(J.blocked.T1.code, 'publish_head_moved');
  assert.equal(pushes(w.dir).length, 0);
  assert.equal(remoteRef(w.bare, 'refs/heads/feat/T1'), null);
  // a dirty work tree (uncommitted unreviewed content) after the adoption is refused the same way
  const d = pubWorld(t);
  let dirtied = false;
  const J2 = await settleAll(d.dir, { hooks: { boundary: async (b) => { if (b === 'after-commit-record' && !dirtied) { dirtied = true; writeFileSync(join(d.wt, 'src', 'extra.txt'), 'x\n'); } } } });
  assert.ok(dirtied);
  assert.equal(J2.blocked.T1.code, 'publish_head_moved');
  assert.equal(pushes(d.dir).length, 0);
});

test('content binding: the SAME content under a NEW commit OID (message amended) is accepted and published', { skip: SKIP }, async (t) => {
  const w = pubWorld(t);
  sh(w.wt, 'commit', '-q', '--amend', '-m', 'T1: a better message');
  const oid = sh(w.wt, 'rev-parse', 'HEAD');
  assert.notEqual(oid, w.commit);
  const J = await settleAll(w.dir);
  assert.equal(J.ship_ready.T1.publication.commit, oid);
  assert.equal(remoteRef(w.bare, 'refs/heads/feat/T1'), oid);
});

test('a remote branch at an ANCESTOR of the OID is a plain fast-forward push (no force); published', { skip: SKIP }, async (t) => {
  const w = pubWorld(t);
  sh(w.wt, 'push', '-q', 'origin', `${w.base}:refs/heads/feat/T1`);
  const J = await settleAll(w.dir);
  assert.deepEqual(J.blocked, {});
  assert.equal(J.ship_ready.T1.publication.pushed.oid, w.commit);
  const p = pushes(w.dir).filter((e) => !e.argv.includes('-q'));
  assert.equal(p.length, 1);
  assert.ok(!p[0].argv.some((a) => /^(-f|--force.*|\+.*)$/.test(a)));
  assert.equal(remoteRef(w.bare, 'refs/heads/feat/T1'), w.commit);
});

test('identity: a fetch or push URL naming another repository is publish_identity_mismatch, refused with no act marker', { skip: SKIP }, async (t) => {
  for (const [why, cfg] of [['fetch url', (wt) => sh(wt, 'remote', 'set-url', 'origin', 'https://github.com/evil/widget.git')],
    ['push url', (wt) => sh(wt, 'remote', 'set-url', '--push', 'origin', 'https://github.com/evil/widget.git')]]) {
    const w = pubWorld(t);
    cfg(w.wt);
    const J = await settleAll(w.dir);
    assert.equal(J.blocked.T1.code, 'publish_identity_mismatch', why);
    const push = Object.values(J.ops).find((o) => o.op === 'push');
    assert.equal(existsSync(push.files.act), false, `${why}: no act marker`);
    assert.equal(effects(w.dir).filter((e) => e.kind === 'git:push').length, 0, why);
  }
});

test('a failed probe before the act is nothing-ran: retried (bounded), then retries_exhausted; never a marker or a push', { skip: SKIP }, async (t) => {
  const w = pubWorld(t, { pub: { fail: { 'ls-remote': true } } });
  const J = await settleAll(w.dir);
  assert.equal(J.blocked.T1.code, 'retries_exhausted');
  const p = Object.values(J.ops).filter((o) => o.op === 'push');
  assert.equal(p.length, 4, 'PUBLISH_RETRY_LIMITS.nothing_ran attempts');
  assert.ok(p.every((o) => o.result.outcome === 'nothing_ran' && !existsSync(o.files.act)));
  assert.equal(effects(w.dir).filter((e) => e.kind === 'git:push').length, 0);
});

test('kill between the act marker and the push: ambiguous, probes find nothing, Blocked; a later candidate change never replays it', { skip: SKIP }, async (t) => {
  const w = pubWorld(t, { pub: { kill_before_push: true } });
  const J = await settleAll(w.dir);
  assert.equal(J.blocked.T1.code, 'ambiguous_unresolved');
  const push = J.ops[J.blocked.T1.op_id];
  assert.equal(push.op, 'push');
  assert.equal(push.state, 'ambiguous');
  assert.ok(existsSync(push.files.act), 'the marker preceded the (never run) push');
  assert.equal(remoteRef(w.bare, 'refs/heads/feat/T1'), null);
  // a successor candidate (the engine state moves to another X) does not erase the predecessor ambiguity
  const S = readState(w.dir, 'T1'); const Y = 'e'.repeat(64);
  writeState(w.dir, 'T1', { ...S, review_chain: [{ ...S.review_chain[0], candidate_id: Y }], freeze: { ...S.freeze, candidate: Y }, local_proof: { candidate_id: Y }, ship_ready: { ...S.ship_ready, candidate_id: Y } });
  const n = effects(w.dir).length;
  const J2 = await settleAll(w.dir);
  assert.equal(effects(w.dir).length, n, 'no new attempt of any kind');
  assert.equal(J2.ops[push.op_id].state, 'ambiguous');
  assert.ok(!Object.keys(J2.ops).some((id) => id.includes(`:c${Y}`)), 'no op of the successor candidate starts');
});

test('a multi-ticket wave: one ticket Blocked (diverged remote) while the independent ticket publishes', { skip: SKIP }, async (t) => {
  const w = pubWorld(t, { keys: ['T1', 'T2'] });
  const other = join(w.dir, 'other');
  sh(w.dir, 'clone', '-q', w.bare, other);
  for (const [k, v] of [['user.name', 'o'], ['user.email', 'o@example.com']]) sh(other, 'config', k, v);
  sh(other, 'checkout', '-q', '-b', 'feat/T1'); writeFileSync(join(other, 'x.txt'), 'x'); sh(other, 'add', '-A'); sh(other, 'commit', '-q', '-m', 'x'); sh(other, 'push', '-q', 'origin', 'feat/T1');
  const J = await settleAll(w.dir);
  assert.equal(J.blocked.T1.code, 'push_requires_force');
  assert.equal(J.ship_ready.T2.publication.pushed.oid, w.tickets.T2.commit);
  assert.equal(remoteRef(w.bare, 'refs/heads/feat/T2'), w.tickets.T2.commit);
  assert.equal(ghState(w.dir).prs.length, 1);
});

test('Block atomicity: a kill right after a refused outcome or a spent probe budget is written leaves the Block written too', { skip: SKIP }, async (t) => {
  const w = pubWorld(t);
  const other = join(w.dir, 'other');
  sh(w.dir, 'clone', '-q', w.bare, other);
  for (const [k, v] of [['user.name', 'o'], ['user.email', 'o@example.com']]) sh(other, 'config', k, v);
  sh(other, 'checkout', '-q', '-b', 'feat/T1'); writeFileSync(join(other, 'x.txt'), 'x'); sh(other, 'add', '-A'); sh(other, 'commit', '-q', '-m', 'x'); sh(other, 'push', '-q', 'origin', 'feat/T1');
  let killed = false;
  for (let i = 0; i < 12 && !killed; i++) { await waitLive(w.dir); killed = child(w.dir, 'after-publish-refused:1 kill').signal === 'SIGKILL'; }
  assert.ok(killed, 'killed right after the refused record');
  const J = journal(w.dir);
  const push = Object.values(J.ops).find((o) => o.op === 'push' && o.result?.outcome === 'refused');
  assert.ok(push, 'the refused outcome is persisted');
  assert.equal(J.blocked.T1?.code, 'push_requires_force', 'and its Block is in the same write');
  const v = pubWorld(t, { pub: { lost_create: true, hide: 99 } });
  killed = false;
  for (let i = 0; i < 40 && !killed; i++) { await waitLive(v.dir); killed = child(v.dir, `after-probe-record:${MAX_PROBES} kill`).signal === 'SIGKILL'; }
  assert.ok(killed, 'killed right after the last probe was recorded');
  const Jv = journal(v.dir);
  const pr = Object.values(Jv.ops).find((o) => o.op === 'pr');
  assert.equal(pr.probes, MAX_PROBES);
  assert.equal(Jv.blocked.T1?.code, 'ambiguous_unresolved', 'a spent budget is never persisted without its Block');
});
