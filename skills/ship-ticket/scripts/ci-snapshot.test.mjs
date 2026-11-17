// Linked CI snapshot contract (ASTF-39, S-05a). Real input: the committed SCRUM-202 jobs fixture (reduced, unlinked,
// no total_count: it can prove job input statuses, NOT binding or completeness). Everything linked is a SYNTHETIC
// replica built here. Tests assert a positive signal (an exact status/reason), never the absence of an error.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSnapshot, readSnapshot, classifyJob, idStr, checkRunRef, PREDICATES } from './ci-snapshot.mjs';

const CLI = fileURLToPath(new URL('./ci-snapshot.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/ci-snapshot/scrum202-abf4d7ea-actions-jobs.jsonl', import.meta.url));
const REPO = 'acme/widgets';
const SHA = 'abf4d7ea1e2257c1dcc42052f156307e81e81d34';
const nl = (items, total = items.length) => [{ total_count: total }, ...items].map((x) => JSON.stringify(x)).join('\n') + '\n';
const url = (id, repo = REPO) => `https://api.github.com/repos/${repo}/check-runs/${id}`;

// SYNTHETIC linked replica: three Actions checks (one failed attempt 1 and its passing attempt 2 of run 100, a failed
// job of run 200 with the same name) plus one third-party check.
const job = (o) => ({ id: 1, name: 'verify', run_id: 100, run_attempt: 1, head_sha: SHA, status: 'completed', conclusion: 'failure', runner_name: '', steps: [], check_run_url: url(o.id ?? 1), ...o });
const check = (o) => ({ id: 1, name: 'verify', head_sha: SHA, status: 'completed', url: url(o.id ?? 1), app: { slug: 'github-actions' }, conclusion: 'failure', output: { annotations_count: 0 }, ...o });
const base = () => ({
  checks: [check({ id: 1 }), check({ id: 2, conclusion: 'success' }), check({ id: 3, name: 'verify' }), check({ id: 4, name: 'review', app: { slug: 'other-app' }, conclusion: 'success' })],
  jobs: { 'run100-1': [job({ id: 1 })], 'run200-1': [job({ id: 3, run_id: 200 })], 'run100-2': [job({ id: 2, run_attempt: 2, conclusion: 'success', steps: [{}], runner_name: 'GitHub Actions 1' })] },
  annotations: {},
});
const texts = (s) => ({ checkRuns: nl(s.checks), jobs: Object.fromEntries(Object.entries(s.jobs).map(([k, v]) => [k + '.jsonl', nl(v)])), annotations: s.annotations, problems: [] });
const build = (s = base(), over = {}) => buildSnapshot({ texts: { ...texts(s), ...over }, repo: REPO, sha: SHA });
const row = (snap, id) => snap.check_runs.find((r) => r.id === String(id));

test('the synthetic replica is complete and fully bound (baseline for every mutation below)', () => {
  const s = build();
  assert.equal(s.state, 'complete'); assert.equal(s.binding_complete, true);
  assert.equal(row(s, 1).binding, 'bound'); assert.equal(row(s, 4).binding, 'external');
  assert.match(s.provider_snapshot_sha256, /^[0-9a-f]{64}$/);
});

test('AC1: a failure-class job with missing or null steps or runner_name is unknown, never ok', () => {
  assert.deepEqual(classifyJob({ conclusion: 'failure', runner_name: '' }), { input_status: 'unknown', reason: 'steps_missing' });
  assert.equal(classifyJob({ conclusion: 'failure', steps: null, runner_name: '' }).reason, 'steps_missing');
  assert.equal(classifyJob({ conclusion: 'failure', steps: [] }).reason, 'runner_name_missing');
  assert.equal(classifyJob({ conclusion: 'timed_out', steps: [], runner_name: null }).reason, 'runner_name_missing');
  assert.equal(classifyJob({ conclusion: 'failure', steps: [], runner_name: '' }).input_status, 'ok');
  assert.equal(classifyJob({ steps: [], runner_name: '' }).reason, 'conclusion_missing');
  const s = base(); delete s.jobs['run100-1'][0].steps;
  assert.equal(row(build(s), 1).input_status, 'unknown');
});

test('AC5 + fixture: the real SCRUM-202 jobs: six zero-step failures are ok, preview (skipped, null runner) is outside_r3; no total_count so the set is incomplete', () => {
  const real = readFileSync(FIXTURE, 'utf8').trim().split('\n');
  const perRun = {}; for (const l of real) (perRun[`run${JSON.parse(l).run_id}.jsonl`] ??= []).push(l);
  const s = buildSnapshot({ texts: { checkRuns: nl([]), jobs: Object.fromEntries(Object.entries(perRun).map(([k, v]) => [k, v.join('\n')])), annotations: {}, problems: [] }, repo: REPO, sha: SHA });
  // all seven lines in ONE file mixes runs: the coherence predicate refuses it
  assert.equal(buildSnapshot({ texts: { checkRuns: nl([]), jobs: { 'all.jsonl': real.join('\n') }, annotations: {}, problems: [] }, repo: REPO, sha: SHA }).state, 'invalid');
  const by = Object.fromEntries(s.jobs.map((j) => [j.name, j]));
  assert.deepEqual(Object.keys(by).sort(), ['audit', 'design-parity', 'nn-guard', 'preview', 'sast', 'secrets', 'verify']);
  for (const n of ['audit', 'design-parity', 'nn-guard', 'sast', 'secrets', 'verify']) { assert.equal(by[n].input_status, 'ok'); assert.equal(by[n].steps, 0); }
  assert.equal(by.preview.input_status, 'outside_r3');
  assert.equal(s.state, 'incomplete'); assert.ok(s.reasons.includes('jobs_run43960407722.jsonl_no_total_count'));
  assert.equal(s.binding_complete, false);
  assert.equal(s.jobs.every((j) => j.bound === false), true); // no check_run_url: orphan, not bound
  // mutation of the real rows: drop steps / null the runner -> unknown
  const lines = readFileSync(FIXTURE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  delete lines[0].steps; lines[1].runner_name = null; lines[6].runner_name = undefined;
  const m = buildSnapshot({ texts: { checkRuns: nl([]), jobs: { 'real.jsonl': lines.map((l) => JSON.stringify(l)).join('\n') }, annotations: {}, problems: [] }, repo: REPO, sha: SHA });
  assert.deepEqual(m.jobs.map((j) => j.input_status), ['unknown', 'unknown', 'ok', 'ok', 'ok', 'ok', 'unknown']);
});

test('AC2: an incomplete page set is incomplete (total mismatch, disagreeing totals, no total, an empty file)', () => {
  const s = base();
  assert.deepEqual([build(s, { checkRuns: nl(s.checks, 5) }).state, build(s, { checkRuns: nl(s.checks, 5) }).reasons], ['incomplete', ['check_runs_items_differ_from_total']]);
  assert.equal(build(s, { checkRuns: nl(s.checks, 3) }).state, 'incomplete');
  assert.equal(build(s, { checkRuns: nl(s.checks.slice(0, 2), 4) }).state, 'incomplete');
  assert.deepEqual(build(s, { checkRuns: JSON.stringify({ total_count: 3 }) + '\n' + nl(s.checks) }).reasons, ['check_runs_total_count_disagree']);
  assert.deepEqual(build(s, { checkRuns: s.checks.map((c) => JSON.stringify(c)).join('\n') }).reasons, ['check_runs_no_total_count']);
  assert.equal(build(s, { checkRuns: '' }).state, 'incomplete');
  assert.ok(build(s, { checkRuns: null }).reasons.includes('check_runs_missing'));
  assert.ok(build(s, { jobs: null }).reasons.includes('jobs_missing'));
  const short = { ...texts(s).jobs, 'run100-2.jsonl': nl([], 1) };
  assert.ok(build(s, { jobs: short }).reasons.includes('jobs_run100-2.jsonl_items_differ_from_total'));
  assert.equal(build(s, { jobs: short }).binding_complete, false);
});

test('AC3: a check run not bound to exactly one job and attempt is unbound (each cause)', () => {
  const cases = {
    no_job: (s) => { delete s.jobs['run100-2']; },
    job_head_sha_mismatch: (s) => { s.jobs['run100-2'][0].head_sha = 'f'.repeat(40); },
    job_repo_mismatch: (s) => { s.jobs['run100-2'][0].check_run_url = url(2, 'other/widgets'); },
    job_name_mismatch: (s) => { s.jobs['run100-2'][0].name = 'lint'; },
    job_identity_invalid: (s) => { s.jobs['run100-2'][0].run_attempt = 1.5; },
    job_id_mismatch: (s) => { s.jobs['run100-1'].push(job({ id: 99, name: 'verify', run_id: 300, check_run_url: url(2) })); },
    head_sha_mismatch: (s) => { s.checks[1].head_sha = 'f'.repeat(40); },
    app_missing: (s) => { s.checks[1].app = null; },
  };
  for (const [why, mutate] of Object.entries(cases)) {
    const s = base(); mutate(s);
    const snap = build(s);
    const r = row(snap, 2);
    assert.equal(r.binding, 'unbound', why); assert.equal(r.reason, why); assert.equal(r.input_status, 'unbound');
    assert.equal(snap.binding_complete, false, why); assert.ok(snap.unbound_check_runs.includes('2'), why);
  }
  // no check_run_url at all: the job is an orphan and the check run unbound
  const s = base(); delete s.jobs['run100-2'][0].check_run_url;
  const snap = build(s); assert.equal(row(snap, 2).reason, 'no_job'); assert.deepEqual(snap.orphan_jobs, ['2']);
  // SHA case is strict on the provider side (a lowercase request still matches a lowercase head)
  const up = base(); up.jobs['run100-2'][0].head_sha = SHA.toUpperCase();
  assert.equal(row(build(up), 2).reason, 'job_head_sha_mismatch');
  // a job naming a check run that does not exist is an orphan job
  const orphan = base(); orphan.jobs['run100-2'].push(job({ id: 77, name: 'x', check_run_url: url(77) }));
  assert.deepEqual(build(orphan).orphan_jobs, ['77']);
});

test('AC4: supersession only within the same run and job name', () => {
  const s = base();
  // check 2 is attempt 2 of run 100 "verify"; check 1 is attempt 1 of the same run: superseded. check 3 is run 200: not.
  const snap = build(s);
  assert.equal(row(snap, 1).supersession, 'superseded'); assert.equal(row(snap, 1).superseded_by_attempt, 2);
  assert.equal(row(snap, 3).supersession, 'not_superseded');
  assert.equal(row(snap, 2).supersession, 'not_applicable');
  // the passing attempt 2 moved to ANOTHER run: the failed attempt is no longer superseded
  const other = base(); other.jobs['run100-2'][0].run_id = 999;
  assert.equal(row(build(other), 1).supersession, 'not_superseded');
  // an unbound failed check run is never superseded
  const unb = base(); delete unb.jobs['run100-1'][0].check_run_url;
  assert.equal(row(build(unb), 1).supersession, 'not_superseded');
});

test('AC6: provider_snapshot_sha256 is canonical (key order immaterial), value-sensitive, and null when invalid', () => {
  const a = build();
  const reordered = base(); reordered.checks = reordered.checks.map((c) => Object.fromEntries(Object.entries(c).reverse()));
  assert.equal(build(reordered).provider_snapshot_sha256, a.provider_snapshot_sha256);
  const changed = base(); changed.checks[0].name = 'verify '; changed.jobs['run100-1'][0].name = 'verify ';
  assert.notEqual(build(changed).provider_snapshot_sha256, a.provider_snapshot_sha256);
  const moved = base(); moved.jobs['run100-1'][0].steps = [{ name: 's' }];
  assert.notEqual(build(moved).provider_snapshot_sha256, a.provider_snapshot_sha256);
  assert.equal(build(base(), { checkRuns: 'not json\n' }).provider_snapshot_sha256, null);
});

test('negatives: invalid input is invalid, never complete', () => {
  const s = base();
  const dupJobs = base(); dupJobs.jobs['run100-2'][0].id = 1;
  assert.ok(build(dupJobs).reasons.includes('job_id_duplicate'));
  const dupChecks = base(); dupChecks.checks[1].id = '1'; // string vs number: same id
  assert.ok(build(dupChecks).reasons.includes('check_run_id_duplicate'));
  assert.equal(idStr('12'), '12'); assert.equal(idStr(12), '12'); assert.equal(idStr(2 ** 60), null); assert.equal(idStr('1e3'), null); assert.equal(idStr(1.5), null); assert.equal(idStr(-1), null);
  const strId = base(); strId.checks[1].id = '2'; assert.equal(row(build(strId), 2).binding, 'bound'); // string id binds like a number
  const unsafe = base(); unsafe.checks[1].id = 2 ** 60; assert.equal(build(unsafe).state, 'invalid');
  assert.equal(build(s, { checkRuns: nl(s.checks) + 'not json\n' }).state, 'invalid');
  assert.equal(build(s, { checkRuns: nl(s.checks) + '[1]\n' }).state, 'invalid');
  assert.equal(build(s, { checkRuns: nl(s.checks) + JSON.stringify({ stray: 1 }) + '\n' }).state, 'invalid');
  assert.equal(buildSnapshot({ texts: texts(s), repo: 'no-slash', sha: SHA }).state, 'invalid');
  assert.equal(buildSnapshot({ texts: texts(s), repo: REPO, sha: 'abc' }).state, 'invalid');
  assert.equal(buildSnapshot({ texts: texts(s), repo: 'ACME/Widgets', sha: SHA.toUpperCase() }).binding_complete, true); // identity compare is case-normalised on the request side
  assert.deepEqual(checkRunRef('https://api.github.com/repos/A/B/check-runs/5'), { repo: 'a/b', id: '5' });
  assert.equal(checkRunRef('https://api.github.com/repos/a/b/check-runs/5/x'), null);
});

test('annotations: the listed count must equal output.annotations_count', () => {
  const ann = (n) => Array.from({ length: n }, (_, i) => JSON.stringify({ message: `m${i}` })).join('\n') + '\n';
  const s = base(); s.checks[0].output.annotations_count = 1; s.annotations['1.jsonl'] = ann(1);
  const ok = build(s); assert.deepEqual(row(ok, 1).annotations, { status: 'present', messages: ['m0'] });
  const none = base(); none.checks[0].output.annotations_count = 1;
  assert.equal(row(build(none), 1).annotations.status, 'missing');
  const short = base(); short.checks[0].output.annotations_count = 2; short.annotations['1.jsonl'] = ann(1);
  assert.deepEqual(row(build(short), 1).annotations, { status: 'incomplete', messages: [], expected: 2, listed: 1 });
  const extra = base(); extra.annotations['1.jsonl'] = ann(1);
  assert.equal(row(build(extra), 1).annotations.status, 'incomplete');
  const unk = base(); delete unk.checks[0].output;
  assert.equal(row(build(unk), 1).annotations.status, 'unknown');
  assert.equal(row(build(), 1).annotations.status, 'none');
  const stray = base(); stray.annotations['999.jsonl'] = ann(1);
  assert.equal(build(stray).state, 'invalid');
  const bad = base(); bad.annotations['1.jsonl'] = '{"x":1}\n';
  assert.equal(build(bad).state, 'invalid');
});

function writeDir(root, s, t = texts(s)) {
  writeFileSync(join(root, 'check-runs.jsonl'), t.checkRuns);
  mkdirSync(join(root, 'jobs')); mkdirSync(join(root, 'annotations'));
  for (const [k, v] of Object.entries(t.jobs)) writeFileSync(join(root, 'jobs', k), v);
  for (const [k, v] of Object.entries(t.annotations)) writeFileSync(join(root, 'annotations', k), v);
}
const trySymlink = (target, path) => { try { symlinkSync(target, path); return true; } catch { return false; } }; // Windows without privilege: skip
const cli = (dir, sha = SHA) => spawnSync(process.execPath, [CLI, 'check', '--snapshot', dir, '--repo', REPO, '--sha', sha], { encoding: 'utf8' });

test('CLI + reader: a complete bound directory exits 0; every filesystem hazard fails closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'cisnap-'));
  try {
    const good = join(root, 'good'); mkdirSync(good); writeDir(good, base());
    const r = cli(good);
    assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).binding_complete, true);
    assert.equal(JSON.stringify(readSnapshot({ dir: good, repo: REPO, sha: SHA })), JSON.stringify(JSON.parse(r.stdout)));

    const bad = join(root, 'bad'); mkdirSync(bad); writeDir(bad, base()); writeFileSync(join(bad, 'jobs', 'run100-1.jsonl'), nl([], 1));
    const rb = cli(bad); assert.equal(rb.status, 1); assert.equal(JSON.parse(rb.stdout).state, 'incomplete');

    const extra = join(root, 'extra'); mkdirSync(extra); writeDir(extra, base()); writeFileSync(join(extra, 'notes.txt'), 'x');
    assert.ok(JSON.parse(cli(extra).stdout).reasons.includes('snapshot_unexpected_entry'));

    const utf = join(root, 'utf'); mkdirSync(utf); writeDir(utf, base()); writeFileSync(join(utf, 'check-runs.jsonl'), Buffer.concat([Buffer.from('{"total_count":1}\n{"id":1,"name":"v'), Buffer.from([0xff]), Buffer.from('"}\n')])); // valid JSON once decoded leniently
    assert.equal(JSON.parse(cli(utf).stdout).state, 'invalid');

    const sym = join(root, 'sym'); mkdirSync(sym); writeDir(sym, base());
    writeFileSync(join(root, 'real.jsonl'), nl(base().checks));
    rmSync(join(sym, 'check-runs.jsonl'));
    if (trySymlink(join(root, 'real.jsonl'), join(sym, 'check-runs.jsonl'))) assert.equal(JSON.parse(cli(sym).stdout).state, 'invalid');

    const crlf = join(root, 'crlf'); mkdirSync(crlf); writeDir(crlf, base());
    writeFileSync(join(crlf, 'check-runs.jsonl'), nl(base().checks).replace(/\n/g, '\r\n'));
    assert.equal(cli(crlf).status, 0);

    assert.equal(spawnSync(process.execPath, [CLI, 'check'], { encoding: 'utf8' }).status, 2);
    assert.equal(cli(join(root, 'nope')).status, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- the completeness predicates: ONE table, each broken in turn from a complete snapshot -------------------------
// Each case: { s(s) mutates the synthetic snapshot, t(t) mutates the texts, args: { sha }, root: 'symlink' | 'extra' }.
const CASES = {
  identity_args: [{ sha: 'abc' }],
  files_safe: [{ root: 'symlink' }, { root: 'extra' }, { t: (x) => { x.annotations['999.jsonl'] = '{"message":"m"}\n'; } }],
  lines_wellformed: [{ t: (x) => { x.checkRuns += 'not json\n'; } }, { s: (s) => { s.checks[3].name = 7; } }],
  pages_complete: [{ t: (x) => { x.checkRuns = nl(base().checks, 9); } }, { t: (x) => { delete x.jobs['run100-2.jsonl']; x.jobs['run100-2.jsonl'] = nl([], 1); } }],
  ids_canonical_unique: [{ s: (s) => { s.jobs['run100-2'][0].id = 1; } }, { s: (s) => { s.checks[3].id = '04'; } }, { s: (s) => { s.checks[3].id = 2 ** 60; } }],
  check_bound_to_repo: [{ s: (s) => { s.checks[3].url = url(4, 'other/widgets'); } }, { s: (s) => { delete s.checks[3].url; } }, { s: (s) => { s.checks[3].head_sha = 'f'.repeat(40); } }],
  actions_check_one_job: [{ s: (s) => { delete s.jobs['run100-2']; } }, { s: (s) => { s.jobs['run100-2'][0].head_sha = 'f'.repeat(40); } }, { s: (s) => { s.jobs['run100-2'][0].name = 'lint'; } },
    { s: (s) => { s.jobs['run100-2'][0].run_attempt = 1.5; } }, { s: (s) => { s.jobs['run100-2'][0].check_run_url = url(2, 'other/widgets'); } }],
  ids_agree: [{ s: (s) => { s.jobs['run100-2'][0].id = 99; } }, { s: (s) => { s.checks[1].url = url(98); } }],
  job_files_coherent: [{ s: (s) => { s.jobs['run100-1'].push(s.jobs['run200-1'].pop()); } }],
  job_name_unique: [{ s: (s) => { s.checks.push(check({ id: 5 })); s.jobs['run100-1'].push(job({ id: 5 })); } }],
  status_consistent: [{ s: (s) => { s.checks[0].status = 'in_progress'; } }, { s: (s) => { s.jobs['run100-1'][0].status = 'queued'; } }, { s: (s) => { s.jobs['run100-2'][0].conclusion = 'failure'; } },
    { s: (s) => { s.checks[3].status = 'in_progress'; } }],
  no_orphan_jobs: [{ s: (s) => { s.jobs['run100-2'].push(job({ id: 77, name: 'x', run_attempt: 2, check_run_url: url(77) })); } }],
  annotations_complete: [{ s: (s) => { s.checks[0].output.annotations_count = 1; } }, { s: (s) => { delete s.checks[3].output; } }, { s: (s) => { s.checks[0].output.annotations_count = 2; s.annotations['1.jsonl'] = '{"message":"a"}\n'; } }],
};

test('completeness registry: every predicate in PREDICATES has a breaking case, and no case names an unknown one', () => {
  assert.deepEqual(Object.keys(CASES).sort(), [...PREDICATES].sort());
  for (const [p, list] of Object.entries(CASES)) assert.ok(list.length > 0, p);
});

test('completeness: the baseline is complete with no failed predicate and exits 0', () => {
  const root = mkdtempSync(join(tmpdir(), 'cisnap-'));
  try {
    writeDir(root, base());
    const r = cli(root);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual([out.state, out.failed_predicates, out.reasons], ['complete', [], []]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const [predicate, list] of Object.entries(CASES)) {
  test(`completeness: breaking ${predicate} makes the snapshot not complete (state, failed_predicates, exit)`, () => {
    list.forEach((c, i) => {
      const root = mkdtempSync(join(tmpdir(), 'cisnap-'));
      try {
        const s = base(); c.s?.(s);
        const x = texts(s); c.t?.(x);
        let dir = join(root, 'snap'); mkdirSync(dir); writeDir(dir, s, x);
        if (c.root === 'extra') writeFileSync(join(dir, 'notes.txt'), 'x');
        if (c.root === 'symlink') { const link = join(root, 'link'); if (!trySymlink(dir, link)) return; dir = link; }
        const r = cli(dir, c.sha ?? SHA);
        const out = JSON.parse(r.stdout);
        const why = `${predicate}[${i}] ${out.reasons.join(',')}`;
        assert.notEqual(out.state, 'complete', why); assert.notEqual(r.status, 0, why);
        assert.ok(out.failed_predicates.includes(predicate), `${why} -> ${out.failed_predicates}`);
        assert.equal(out.binding_complete, false, why);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  });
}

test('supersession: only a completed, executed higher attempt of the same run and job name supersedes', () => {
  assert.equal(row(build(), 1).supersession, 'superseded');
  for (const [status, conclusion] of [['in_progress', null], ['completed', 'skipped'], ['completed', 'neutral'], ['completed', 'cancelled']]) {
    const s = base(); Object.assign(s.jobs['run100-2'][0], { status, conclusion }); Object.assign(s.checks[1], { status, conclusion });
    assert.equal(row(build(s), 1).supersession, 'not_superseded', `${status}/${conclusion}`);
  }
  // a later attempt that itself failed still supersedes the earlier one (its own failure remains visible)
  const f = base(); Object.assign(f.jobs['run100-2'][0], { conclusion: 'failure', steps: [], runner_name: '' }); f.checks[1].conclusion = 'failure';
  assert.equal(row(build(f), 1).supersession, 'superseded'); assert.equal(row(build(f), 2).supersession, 'not_superseded');
  // two same-named jobs in one run attempt: one is re-run and passes; neither failure is hidden
  const amb = base(); amb.checks.push(check({ id: 5 })); amb.jobs['run100-1'].push(job({ id: 5 }));
  const snap = build(amb);
  assert.deepEqual([row(snap, 1).reason, row(snap, 5).reason, row(snap, 1).supersession, row(snap, 5).supersession], ['ambiguous_job_name', 'ambiguous_job_name', 'not_superseded', 'not_superseded']);
});

test('ids: a leading zero is not canonical anywhere (ids and URL references)', () => {
  assert.equal(idStr('01'), null); assert.equal(idStr('0'), '0'); assert.equal(checkRunRef('https://api.github.com/repos/a/b/check-runs/01'), null);
});
