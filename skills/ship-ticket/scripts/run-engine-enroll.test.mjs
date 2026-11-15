/**
 * P0 slices E1 (mandatory engine enrollment) and E4 (trusted context delivery). Drives the REAL
 * engine CLI (`node run-engine.mjs`) on a temp repo with a fake provider, a fake `gh` and a local
 * bare remote; no model call. Contract: engine-enroll.mjs header and execution-harness.md,
 * Enrollment and authorization.
 *
 * Trust, as tested here: decisions read only the enrollment ledger and the engine state. Lines
 * forged into the engine log or the plan's RUN-STATE are inert; a malformed ledger fails closed; a
 * WELL-FORMED rewrite of the ledger by a same-user process is accepted (the documented residual,
 * the same one the engine state file has), and DEGRADED_APPROVED is detected, not enforced.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, appendFileSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { POSIX } from './engine-test-fixture.mjs';
import { enrollFixture, skillCopy } from './engine-enroll.test-helper.mjs';
import { buildManifest, manifestText, verifySkill } from './context-manifest.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ENGINE = fileURLToPath(new URL('./run-engine.mjs', import.meta.url));
const spawnCli = (fx, args) => spawnSync(process.execPath, [ENGINE, ...args], { encoding: 'utf8', env: fx.env });

const WIN_SKIP = POSIX ? false : 'POSIX process groups (engine) and sh fakes';
const allowed = (r, code = 'allow') => { assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(r.out.allow, true); assert.equal(r.out.code, code); };
const denied = (r, code) => {
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(r.out?.allow ?? false, false, r.stdout);
  if (r.out) assert.equal(r.out.code, code, r.stdout);
  assert.match(r.stderr, new RegExp(`^(authorize|publish): .*${code}`, 'm'));
};

/** Ship-ready and committed: the state in which `publish` is the next action. */
function shippable(t, opts) {
  const fx = enrollFixture(t, opts);
  fx.toShipReady();
  fx.commitAll();
  assert.equal(fx.cli('context', { phase: 'ship' }).status, 0);
  return fx;
}

test('never enrolled: every stage is denied and publish pushes nothing', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t);
  for (const stage of ['build', 'publish', 'complete']) denied(fx.cli('authorize', { stage }), 'not_enrolled');
  const p = fx.cli('publish', {});
  denied(p, 'not_enrolled');
  assert.equal(p.out.published, false);
  assert.equal(fx.remoteHead(), null, 'nothing reached the remote');
});

test('enroll is idempotent per run, reuses the latest run without --run-id, and records provenance', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t);
  const a = fx.cli('enroll', {});
  const b = fx.cli('enroll', {});
  assert.equal(a.status, 0, a.stderr);
  assert.deepEqual([a.out.already, b.out.already], [false, true]);
  const enrolled = fx.ledger().events.filter(e => e.type === 'ENROLLED');
  assert.equal(enrolled.length, 1);
  const e = enrolled[0];
  assert.equal(e.ticket, 'T-1');
  assert.equal(e.branch, 'T-1-work');
  assert.equal(e.repo, fx.repo);
  assert.match(e.skill_digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(e.manifest_digest, /^sha256:[0-9a-f]{64}$/);
  assert.ok('skill_revision' in e);
  // without --run-id: the ticket's latest enrolled run, not a new one
  const r = JSON.parse(spawnCli(fx, ['enroll', '--repo', fx.repo, '--ticket', 'T-1']).stdout);
  assert.equal(r.run_id, 'run-1');
  assert.equal(r.already, true);
});

test('the supported path: publish pushes after authorize, opens the PR, records PUBLISHED; complete stops at the CI placeholder', { skip: WIN_SKIP }, (t) => {
  const fx = shippable(t);
  denied(fx.cli('authorize', { stage: 'complete' }), 'publish_evidence_missing');
  const body = join(fx.root, 'pr.md');
  writeFileSync(body, 'PR body');
  const r = spawnCli(fx, ['publish', '--repo', fx.repo, '--ticket', 'T-1', '--run-id', 'run-1', '--pr-title', 'T-1: ship', '--pr-body-file', body, '--draft']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.code, 'published');
  assert.equal(fx.remoteHead(), fx.head(), 'the authorized HEAD reached the remote');
  assert.deepEqual(fx.ghLog(), [['pr', 'create', '--head', 'T-1-work', '--title', 'T-1: ship', '--body-file', body, '--draft']]);
  const pub = fx.ledger().events.filter(e => e.type === 'PUBLISHED');
  assert.equal(pub.length, 1);
  assert.deepEqual([pub[0].head, pub[0].branch, pub[0].pr.url, pub[0].degraded], [fx.head(), 'T-1-work', 'https://example.invalid/pr/1', false]);
  const c = fx.cli('authorize', { stage: 'complete' });
  denied(c, 'ci_evidence_unavailable');
  assert.match(c.out.reasons[0], /slice E6/);
  assert.equal(fx.git(['status', '--porcelain']).stdout, '', 'publish wrote nothing into the work tree (no RUN-STATE line)');
});

test('stale candidate: changed candidate bytes after SHIP_READY are denied; a non-candidate git event still allows', { skip: WIN_SKIP }, (t) => {
  const fx = shippable(t);
  allowed(fx.cli('authorize', { stage: 'publish' }));
  // non-candidate events: an empty commit, a tag, an excluded file committed
  fx.okGit(['commit', '-q', '--allow-empty', '-m', 'empty']);
  fx.okGit(['tag', 'v-test']);
  writeFileSync(join(fx.repo, 'session-log.md'), 'entry');
  fx.commitAll('log');
  const a = fx.cli('authorize', { stage: 'publish' });
  allowed(a);
  assert.equal(a.out.head, fx.head());
  // candidate bytes change, committed: stale
  writeFileSync(join(fx.repo, 'src', 'a.txt'), 'changed after review');
  fx.commitAll('edit');
  const s = fx.cli('authorize', { stage: 'publish' });
  denied(s, 'candidate_stale');
  const p = fx.cli('publish', {});
  denied(p, 'candidate_stale');
  assert.equal(fx.remoteHead(), null);
});

test('what is pushed must be what was reviewed: unreviewed bytes committed with the tree reverted is tree_dirty', { skip: WIN_SKIP }, (t) => {
  const fx = shippable(t);
  writeFileSync(join(fx.repo, 'src', 'a.txt'), 'unreviewed');
  fx.commitAll('sneak');
  writeFileSync(join(fx.repo, 'src', 'a.txt'), 'a1'); // the reviewed bytes, uncommitted: candidate id matches
  denied(fx.cli('authorize', { stage: 'publish' }), 'tree_dirty');
  writeFileSync(join(fx.repo, 'untracked.txt'), 'x');
  fx.okGit(['checkout', '--', 'src/a.txt']);
  denied(fx.cli('authorize', { stage: 'publish' }), 'tree_dirty');
});

test('ship branch and base: a branch not naming the ticket and a HEAD base are denied with their own codes', { skip: WIN_SKIP }, (t) => {
  const fx = shippable(t);
  fx.okGit(['checkout', '-q', '-b', 'feature-x']);
  denied(fx.cli('authorize', { stage: 'publish' }), 'branch_not_ticket');
  fx.okGit(['checkout', '-q', '--detach']);
  denied(fx.cli('authorize', { stage: 'publish' }), 'branch_detached');
  const h = enrollFixture(t, { base: 'HEAD' });
  h.toShipReady();
  h.commitAll();
  assert.equal(h.cli('context', { phase: 'ship' }).status, 0);
  denied(h.cli('authorize', { stage: 'publish' }), 'candidate_base_head');
});

test('degraded: denied without DEGRADED_APPROVED, allowed with it, and bound to the approved HEAD', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t);
  assert.equal(fx.cli('enroll', {}).status, 0);
  assert.equal(fx.cli('context', { phase: 'build' }).status, 0);
  assert.equal(fx.cli('context', { phase: 'ship' }).status, 0);
  denied(fx.cli('authorize', { stage: 'build' }), 'engine_not_initialized');
  const d = fx.cli('degrade', { reason: 'engine unavailable on this host' });
  assert.equal(d.status, 0, d.stderr);
  for (const stage of ['build', 'publish', 'complete']) denied(fx.cli('authorize', { stage }), 'degraded_unapproved');
  const empty = fx.cli('approve-degraded', { 'owner-quote': '   ' });
  assert.equal(empty.status, 2, 'an empty quote is refused');
  assert.match(empty.stderr, /approval_refused/);
  writeFileSync(join(fx.repo, 'src', 'a.txt'), 'manual');
  fx.commitAll('manual build');
  const ap = fx.cli('approve-degraded', { 'owner-quote': '"Ship it without the engine." (owner, chat)' });
  assert.equal(ap.status, 0, ap.stderr);
  assert.equal(ap.out.trust, 'orchestrator-recorded');
  assert.equal(fx.cli('approve-degraded', { 'owner-quote': 'again' }).status, 2, 'nothing left to approve');
  allowed(fx.cli('authorize', { stage: 'build' }), 'allow_degraded');
  const a = fx.cli('authorize', { stage: 'publish' });
  allowed(a, 'allow_degraded');
  assert.deepEqual(a.out.skipped, ['engine_binding', 'ship_ready', 'candidate']);
  fx.okGit(['commit', '-q', '--allow-empty', '-m', 'after approval']);
  denied(fx.cli('authorize', { stage: 'publish' }), 'degraded_approval_stale');
  fx.okGit(['reset', '-q', '--hard', 'HEAD~1']);
  const p = fx.cli('publish', {});
  assert.equal(p.status, 0, p.stdout + p.stderr);
  assert.equal(fx.ledger().events.at(-1).degraded, true);
  // a second DEGRADED needs its own approval
  assert.equal(fx.cli('degrade', { reason: 'again' }).status, 0);
  denied(fx.cli('authorize', { stage: 'publish' }), 'degraded_unapproved');
});

test('context: missing, changed and extra references and manifest drift block delivery and authorization', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t);
  const s = skillCopy(fx);
  assert.equal(s.cli('enroll').status, 0);
  const ok = s.cli('context', { phase: 'build' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /===== BEGIN references\/execution-harness\.md sha256:/);
  assert.ok(ok.stdout.includes(readFileSync(join(s.dir, 'references', 'brief.md'), 'utf8')), 'the exact bytes are delivered');
  const harness = join(s.dir, 'references', 'execution-harness.md');
  const original = readFileSync(harness, 'utf8');

  writeFileSync(harness, original + '\nedited\n');
  let r = s.cli('context', { phase: 'build' });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '', 'nothing is delivered');
  assert.match(r.stderr, /reference_changed/);
  denied(s.cli('authorize', { stage: 'build' }), 'reference_changed');
  writeFileSync(harness, original);

  writeFileSync(join(s.dir, 'references', 'extra.md'), 'x');
  assert.match(s.cli('context', { phase: 'review' }).stderr, /reference_extra/);
  unlinkSync(join(s.dir, 'references', 'extra.md'));

  rmSync(join(s.dir, 'references', 'review.md'));
  r = s.cli('context', { phase: 'review' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /reference_missing/);
  denied(s.cli('authorize', { stage: 'build' }), 'reference_missing');
  writeFileSync(join(s.dir, 'references', 'review.md'), 'a new review card');
  // the skill was updated properly (manifest rebuilt): it is not the enrolled one any more
  writeFileSync(join(s.dir, 'references', 'context-manifest.json'), manifestText(buildManifest(s.dir)));
  assert.equal(verifySkill(s.dir).ok, true);
  r = s.cli('context', { phase: 'build' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /manifest_drift/);
  denied(s.cli('authorize', { stage: 'build' }), 'manifest_drift');
  const re = s.cli('enroll');
  assert.equal(re.out.already, false);
  assert.equal(typeof re.out.event.supersedes, 'number');
  denied(s.cli('authorize', { stage: 'build' }), 'context_stale');
  assert.equal(s.cli('context', { phase: 'build' }).status, 0);
  denied(s.cli('authorize', { stage: 'build' }), 'engine_not_initialized'); // context now holds; the next prerequisite speaks
});

test('an enrolled run: init needs its plan context and drive its build context; un-enrolled drive is unchanged', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t);
  assert.equal(fx.cli('enroll', {}).status, 0);
  const i = fx.cli('init', { dag: fx.dagFile });
  assert.equal(i.status, 1);
  assert.match(i.stderr, /context_missing/);
  assert.equal(fx.cli('context', { phase: 'plan' }).status, 0);
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  const d = fx.cli('drive');
  assert.equal(d.status, 2, d.stdout);
  assert.ok(d.out.judgments.some(j => j.code === 'context_missing'), d.stdout);
  assert.deepEqual(fx.runs(), [], 'nothing was dispatched');
  assert.equal(fx.cli('context', { phase: 'build' }).status, 0);
  assert.equal(fx.cli('drive').status, 0);
  assert.deepEqual(fx.runs(), ['a']);
  // a different run of the same ticket is not enrolled: its context gate does not apply, publish still does
  denied(fx.cli('authorize', { stage: 'build' }, { runId: 'run-2' }), 'not_enrolled');
});

test('read-only commands are never blocked: status and context work un-enrolled and while degraded', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t);
  const c = fx.cli('context', { phase: 'understand' });
  assert.equal(c.status, 0);
  assert.match(c.stdout, /references\/understand\.md/);
  assert.match(c.stderr, /"recorded":false,"code":"not_enrolled"/);
  assert.equal(fx.cli('enroll', {}).status, 0);
  assert.equal(fx.cli('context', { phase: 'plan' }).status, 0);
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  assert.equal(fx.cli('degrade', { reason: 'x' }).status, 0);
  assert.equal(fx.cli('status').status, 0);
  // the approval is refused while an engine attempt may still run (dispatched code could record it)
  fx.editState(S => { S.attempts.push({ attempt_id: 'att-x', node: 'a', status: 'running' }); });
  const live = fx.cli('approve-degraded', { 'owner-quote': 'ok' });
  assert.equal(live.status, 2);
  assert.match(live.stderr, /attempts_live/);
  const d = fx.cli('context', { phase: 'review' });
  assert.equal(d.status, 0);
  assert.match(d.stderr, /"recorded":true/);
});

test('two tickets and two runs never authorize each other', { skip: WIN_SKIP }, (t) => {
  const fx = shippable(t);
  allowed(fx.cli('authorize', { stage: 'publish' }));
  denied(fx.cli('authorize', { stage: 'publish' }, { runId: 'run-2' }), 'not_enrolled');
  assert.equal(fx.cli('enroll', {}, { runId: 'run-2' }).status, 0);
  assert.equal(fx.cli('context', { phase: 'ship' }, { runId: 'run-2' }).status, 0);
  denied(fx.cli('authorize', { stage: 'publish' }, { runId: 'run-2' }), 'run_mismatch');
  const other = spawnCli(fx, ['authorize', '--stage', 'publish', '--repo', fx.repo, '--ticket', 'T-2', '--run-id', 'run-1']);
  assert.equal(other.status, 2);
  assert.equal(JSON.parse(other.stdout).code, 'not_enrolled');
});

test('forged records: engine-log and RUN-STATE lines are inert, a malformed ledger fails closed, a well-formed rewrite is the residual', { skip: WIN_SKIP }, (t) => {
  const fx = shippable(t);
  const ledger = fx.ledger();
  const enrolled = ledger.events.find(e => e.type === 'ENROLLED');
  const ctx = ledger.events.find(e => e.type === 'CONTEXT_DELIVERED' && e.phase === 'ship');
  // 1. lines forged into the engine log and RUN-STATE for an un-enrolled run authorize nothing
  appendFileSync(fx.engineLog(), JSON.stringify({ ...enrolled, run_id: 'run-9', event: 'ENROLLED', event_id: 'forged-1' }) + '\n'
    + JSON.stringify({ ...ctx, run_id: 'run-9', event: 'CONTEXT_DELIVERED', event_id: 'forged-2' }) + '\n');
  fx.appendRunState({ ...enrolled, run_id: 'run-9', event: 'ENROLLED' });
  denied(fx.cli('authorize', { stage: 'publish' }, { runId: 'run-9' }), 'not_enrolled');
  // 2. a hand edit that is not a ledger fails closed, for every stage and for publish
  const good = readFileSync(fx.ledgerFile(), 'utf8');
  writeFileSync(fx.ledgerFile(), good.replace('"type": "ENROLLED"', '"type": "ENROLLED_BY_HAND"'));
  denied(fx.cli('authorize', { stage: 'publish' }), 'enrollment_unreadable');
  writeFileSync(fx.ledgerFile(), good.slice(0, 40));
  denied(fx.cli('publish', {}), 'enrollment_unreadable');
  assert.equal(fx.remoteHead(), null);
  // 3. RESIDUAL: a same-user process writing a WELL-FORMED ledger is accepted. Here it deletes the
  //    DEGRADED gate it recorded earlier; nothing in the ledger can detect that (the engine state has
  //    the same property). A forged CONTEXT_DELIVERED must still name the current manifest and inventory.
  writeFileSync(fx.ledgerFile(), good);
  assert.equal(fx.cli('degrade', { reason: 'blocked' }).status, 0);
  denied(fx.cli('authorize', { stage: 'publish' }), 'degraded_unapproved');
  const L = fx.ledger();
  L.events = L.events.filter(e => e.type !== 'DEGRADED');
  writeFileSync(fx.ledgerFile(), JSON.stringify(L));
  allowed(fx.cli('authorize', { stage: 'publish' }));
  L.events = L.events.filter(e => e.type !== 'CONTEXT_DELIVERED').concat([{ ...ctx, seq: 99, manifest_digest: 'sha256:' + '0'.repeat(64) }]);
  writeFileSync(fx.ledgerFile(), JSON.stringify(L));
  denied(fx.cli('authorize', { stage: 'publish' }), 'context_stale');
});
