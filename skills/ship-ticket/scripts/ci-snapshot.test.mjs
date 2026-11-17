// Linked CI snapshot contract (ASTF-39, S-05a). Real input: the committed SCRUM-202 jobs fixture (reduced, unlinked,
// no total_count: it can prove job input statuses, NOT binding or completeness). Everything linked is a SYNTHETIC
// replica built here. Tests assert a positive signal (an exact status/reason), never the absence of an error.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, symlinkSync, truncateSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSnapshot, readSnapshot, classifyJob, idStr, checkRunRef, PREDICATES, SITES, NOT_ATTESTED, CONCLUSIONS, SHAPES, shapeProblem } from './ci-snapshot.mjs';

const CLI = fileURLToPath(new URL('./ci-snapshot.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/ci-snapshot/scrum202-abf4d7ea-actions-jobs.jsonl', import.meta.url));
const REPO = 'acme/widgets';
const ORIGIN = 'https://api.github.com';
const SHA = 'abf4d7ea1e2257c1dcc42052f156307e81e81d34';
const nl = (items, total = items.length) => [{ total_count: total }, ...items].map((x) => JSON.stringify(x)).join('\n') + '\n';
const url = (id, repo = REPO) => `https://api.github.com/repos/${repo}/check-runs/${id}`;

// SYNTHETIC linked replica: three Actions checks (one failed attempt 1 and its passing attempt 2 of run 100, a failed
// job of run 200 with the same name) plus one third-party check.
const job = (o) => ({ id: 1, name: 'verify', run_id: 100, run_attempt: 1, head_sha: SHA, status: 'completed', conclusion: 'failure', runner_name: '', steps: [], check_run_url: url(o.id ?? 1), ...o });
const check = (o) => ({ id: 1, name: 'verify', head_sha: SHA, status: 'completed', url: url(o.id ?? 1), app: { slug: 'github-actions' }, conclusion: 'failure', output: { annotations_count: 0 }, ...o });
const base = () => ({
  checks: [check({ id: 1 }), check({ id: 2, conclusion: 'success' }), check({ id: 3, name: 'verify' }), check({ id: 4, name: 'review', app: { slug: 'other-app' }, conclusion: 'success' })],
  jobs: { 'run100-1': [job({ id: 1 })], 'run200-1': [job({ id: 3, run_id: 200 })], 'run100-2': [job({ id: 2, run_attempt: 2, conclusion: 'success', steps: [{ name: 's', status: 'completed', conclusion: 'success', number: 1 }], runner_name: 'GitHub Actions 1' })] },
  annotations: {},
});
const texts = (s) => ({ checkRuns: nl(s.checks), jobs: Object.fromEntries(Object.entries(s.jobs).map(([k, v]) => [k + '.jsonl', nl(v)])), annotations: s.annotations, problems: [] });
const build = (s = base(), over = {}) => buildSnapshot({ texts: { ...texts(s), ...over }, repo: REPO, sha: SHA, origin: ORIGIN });
const row = (snap, id) => snap.check_runs.find((r) => r.id === String(id));

test('the synthetic replica is snapshot_valid and fully bound (baseline for every mutation below)', () => {
  const s = build();
  assert.equal(s.state, 'snapshot_valid'); assert.equal(s.internally_consistent, true);
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
  const s = buildSnapshot({ texts: { checkRuns: nl([]), jobs: Object.fromEntries(Object.entries(perRun).map(([k, v]) => [k, v.join('\n')])), annotations: {}, problems: [] }, repo: REPO, sha: SHA, origin: ORIGIN });
  // all seven lines in ONE file mixes runs: the coherence predicate refuses it
  assert.equal(buildSnapshot({ texts: { checkRuns: nl([]), jobs: { 'all.jsonl': real.join('\n') }, annotations: {}, problems: [] }, repo: REPO, sha: SHA, origin: ORIGIN }).state, 'invalid');
  const by = Object.fromEntries(s.jobs.map((j) => [j.name, j]));
  assert.deepEqual(Object.keys(by).sort(), ['audit', 'design-parity', 'nn-guard', 'preview', 'sast', 'secrets', 'verify']);
  for (const n of ['audit', 'design-parity', 'nn-guard', 'sast', 'secrets', 'verify']) { assert.equal(by[n].input_status, 'ok'); assert.equal(by[n].inputs.steps.length, 0); }
  assert.equal(by.preview.input_status, 'outside_r3');
  assert.equal(s.state, 'incomplete'); assert.ok(s.reasons.includes('jobs_run43960407722.jsonl_no_total_count'));
  assert.equal(s.internally_consistent, false);
  assert.equal(s.jobs.every((j) => j.bound === false), true); // no check_run_url: orphan, not bound
  // mutation of the real rows: drop steps / null the runner -> unknown
  const lines = readFileSync(FIXTURE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  delete lines[0].steps; lines[1].runner_name = null; lines[6].runner_name = undefined;
  const m = buildSnapshot({ texts: { checkRuns: nl([]), jobs: { 'real.jsonl': lines.map((l) => JSON.stringify(l)).join('\n') }, annotations: {}, problems: [] }, repo: REPO, sha: SHA, origin: ORIGIN });
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
  assert.equal(build(s, { jobs: short }).internally_consistent, false);
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
    assert.equal(snap.internally_consistent, false, why); assert.ok(snap.unbound_check_runs.includes('2'), why);
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

test('negatives: invalid input is invalid, never snapshot_valid', () => {
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
  assert.equal(buildSnapshot({ texts: texts(s), repo: 'no-slash', sha: SHA, origin: ORIGIN }).state, 'invalid');
  assert.equal(buildSnapshot({ texts: texts(s), repo: REPO, sha: 'abc', origin: ORIGIN }).state, 'invalid');
  assert.equal(buildSnapshot({ texts: texts(s), repo: 'ACME/Widgets', sha: SHA.toUpperCase(), origin: ORIGIN }).internally_consistent, true); // identity compare is case-normalised on the request side
  assert.deepEqual(checkRunRef('https://api.github.com/repos/A/B/check-runs/5', ORIGIN), { repo: 'a/b', id: '5' });
  assert.equal(checkRunRef('https://api.github.com/repos/a/b/check-runs/5/x', ORIGIN), null);
});

test('annotations: the listed count must equal output.annotations_count', () => {
  const ann = (n) => Array.from({ length: n }, (_, i) => JSON.stringify({ message: `m${i}` })).join('\n') + '\n';
  const s = base(); s.checks[0].output.annotations_count = 1; s.annotations['1.jsonl'] = ann(1);
  const ok = build(s); assert.deepEqual([row(ok, 1).annotations.status, row(ok, 1).annotations.messages, row(ok, 1).annotations.count], ['present', ['m0'], 1]); assert.match(row(ok, 1).annotations.sha256, /^[0-9a-f]{64}$/);
  const none = base(); none.checks[0].output.annotations_count = 1;
  assert.equal(row(build(none), 1).annotations.status, 'missing');
  const short = base(); short.checks[0].output.annotations_count = 2; short.annotations['1.jsonl'] = ann(1);
  assert.deepEqual([row(build(short), 1).annotations.status, row(build(short), 1).annotations.expected, row(build(short), 1).annotations.listed], ['incomplete', 2, 1]);
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
const cli = (dir, sha = SHA) => spawnSync(process.execPath, [CLI, 'check', '--snapshot', dir, '--repo', REPO, '--sha', sha, '--origin', ORIGIN], { encoding: 'utf8' });

test('CLI + reader: a valid bound directory exits 0; every filesystem hazard fails closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'cisnap-'));
  try {
    const good = join(root, 'good'); mkdirSync(good); writeDir(good, base());
    const r = cli(good);
    assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).internally_consistent, true);
    assert.equal(JSON.stringify(readSnapshot({ dir: good, repo: REPO, sha: SHA, origin: ORIGIN })), JSON.stringify(JSON.parse(r.stdout)));

    const bad = join(root, 'bad'); mkdirSync(bad); writeDir(bad, base()); writeFileSync(join(bad, 'jobs', 'run100-1.jsonl'), nl([], 1));
    const rb = cli(bad); assert.equal(rb.status, 1); assert.equal(JSON.parse(rb.stdout).state, 'incomplete');

    const extra = join(root, 'extra'); mkdirSync(extra); writeDir(extra, base()); writeFileSync(join(extra, 'notes.txt'), 'x');
    assert.ok(JSON.parse(cli(extra).stdout).reasons.includes('unexpected_entry'));

    const utf = join(root, 'utf'); mkdirSync(utf); writeDir(utf, base()); writeFileSync(join(utf, 'check-runs.jsonl'), Buffer.concat([Buffer.from('{"total_count":1}\n{"id":1,"name":"v'), Buffer.from([0xff]), Buffer.from('"}\n')])); // valid JSON once decoded leniently
    assert.equal(JSON.parse(cli(utf).stdout).state, 'invalid');


    const crlf = join(root, 'crlf'); mkdirSync(crlf); writeDir(crlf, base());
    writeFileSync(join(crlf, 'check-runs.jsonl'), nl(base().checks).replace(/\n/g, '\r\n'));
    assert.equal(cli(crlf).status, 0);

    assert.equal(spawnSync(process.execPath, [CLI, 'check'], { encoding: 'utf8' }).status, 2);
    assert.equal(cli(join(root, 'nope')).status, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- the validity predicates: ONE table, each reason of each predicate broken in turn from a snapshot_valid snapshot ----
// Case: { reason, s(s) mutates the synthetic snapshot, t(texts) mutates the texts, args, root: <file-system hazard>, want }.
const big = () => base().checks;
const CASES = {
  identity_args: [{ reason: 'repo_malformed', args: { repo: 'x' } }, { reason: 'sha_malformed', args: { sha: 'abc' } }, { reason: 'origin_malformed', args: { origin: 'http://api.github.com' } }],
  files_safe: [{ reason: 'file_not_regular_or_too_large', root: 'dircheck' }, { reason: 'file_not_regular_or_too_large', root: 'oversized' }, { reason: 'file_not_regular_or_too_large', root: 'filelink' },
    { reason: 'file_unreadable_or_not_utf8', root: 'badutf8' }, { reason: 'entry_not_a_directory', root: 'jobs_is_file' }, { reason: 'dir_unreadable', root: 'unreadable' },
    { reason: 'unexpected_entry', root: 'extra' }, { reason: 'unexpected_entry', root: 'extra_in_jobs' }, { reason: 'unexpected_entry', root: 'extra_in_annotations' }, { reason: 'root_not_a_real_directory', root: 'missing_root' }, { reason: 'root_not_a_real_directory', root: 'symlink' }, { reason: 'root_not_a_real_directory', root: 'symlink_slash' }, { reason: 'root_not_a_real_directory', root: 'symlink_dot' }, { reason: 'root_not_a_real_directory', root: 'symlink_dotslash' },
    { reason: 'root_not_a_real_directory', root: 'symlink_updir' }, { reason: 'root_not_a_real_directory', root: 'symlink_rel' },
    { reason: 'annotation_file_unexpected', t: (x) => { x.annotations['999.jsonl'] = '{"message":"m"}\n'; } }],
  lines_wellformed: [{ reason: 'not_json_lines', t: (x) => { x.checkRuns += 'not json\n'; } }, { reason: 'unrecognised_line', t: (x) => { x.checkRuns += '{"stray":1}\n'; } },
    { reason: 'name_not_string', s: (s) => { s.checks[3].name = 7; } }, { reason: 'annotation_not_an_annotation', t: (x) => { x.annotations['1.jsonl'] = '{"x":1}\n'; } },
    { reason: 'annotation_not_an_annotation', t: (x) => { x.annotations['1.jsonl'] = '{"message":"m","extra":1}\n'; } },
    { reason: 'too_deep', t: (x) => { x.checkRuns += '{"a":'.repeat(40) + '1' + '}'.repeat(40) + '\n'; } }, { reason: 'name_not_string', s: (s) => { s.checks[3].name = { toString: 1 }; } }],
  pages_complete: [{ reason: 'check_runs_missing', root: 'nocheckfile' }, { reason: 'jobs_missing', root: 'nojobsdir' }, { reason: 'no_total_count', t: (x) => { x.checkRuns = big().map((c) => JSON.stringify(c)).join('\n'); } },
    { reason: 'total_count_disagree', t: (x) => { x.checkRuns = JSON.stringify({ total_count: 3 }) + '\n' + nl(big()); } }, { reason: 'items_differ_from_total', t: (x) => { x.checkRuns = nl(big(), 9); } }],
  ids_canonical_unique: [{ reason: 'id_invalid', s: (s) => { s.checks[3].id = '04'; } }, { reason: 'id_invalid', s: (s) => { s.checks[3].id = 2 ** 60; } }, { reason: 'id_duplicate', s: (s) => { s.jobs['run100-2'][0].id = 1; } }],
  non_empty: [{ reason: 'no_check_runs', want: 'empty', s: (s) => { s.checks = []; s.jobs = {}; } }],
  check_bound_to_repo: [{ reason: 'own_url_not_origin_repo', s: (s) => { s.checks[3].url = { toString: 1 }; } }, { reason: 'own_url_not_origin_repo', s: (s) => { s.checks[3].url = url(4, 'other/widgets'); } }, { reason: 'own_url_not_origin_repo', s: (s) => { s.checks[3].url = s.checks[3].url.replace('api.github.com', 'ghe.example'); } },
    { reason: 'own_url_not_origin_repo', s: (s) => { delete s.checks[3].url; } }, { reason: 'head_sha_mismatch', s: (s) => { s.checks[3].head_sha = 'f'.repeat(40); } }, { reason: 'app_missing', s: (s) => { s.checks[3].app = null; } }],
  ids_agree: [{ reason: 'own_id_mismatch', s: (s) => { s.checks[1].url = url(98); } }, { reason: 'job_id_mismatch', s: (s) => { s.jobs['run100-2'][0].id = 99; } }],
  actions_check_one_job: [{ reason: 'no_job', s: (s) => { delete s.jobs['run100-2']; } }, { reason: 'no_job', s: (s) => { s.jobs['run100-2'][0].check_run_url = { toString: 1 }; } }, { reason: 'no_job', s: (s) => { s.jobs['run100-2'][0].check_run_url = url(2).replace('api.github.com', 'ghe.example'); } },
    { reason: 'job_repo_mismatch', s: (s) => { s.jobs['run100-2'][0].check_run_url = url(2, 'other/widgets'); } }, { reason: 'job_head_sha_mismatch', s: (s) => { s.jobs['run100-2'][0].head_sha = 'f'.repeat(40); } },
    { reason: 'job_name_mismatch', s: (s) => { s.jobs['run100-2'][0].name = 'lint'; } }, { reason: 'job_identity_invalid', s: (s) => { s.jobs['run100-2'][0].run_attempt = 1.5; } },
    { reason: 'job_identity_invalid', s: (s) => { s.jobs['run100-2'][0].run_attempt = 1e100; } }, { reason: 'job_identity_invalid', s: (s) => { delete s.jobs['run100-2'][0].run_id; } }],
  raw_fields_typed: [{ reason: 'field_type', s: (s) => { s.checks[0].started_at = {}; } }, { reason: 'field_type', s: (s) => { s.jobs['run100-2'][0].runner_name = {}; } }, { reason: 'field_type', s: (s) => { s.jobs['run100-1'][0].runner_group_name = 7; } },
    { reason: 'field_type', s: (s) => { s.jobs['run100-2'][0].steps[0].conclusion = 'bogus'; } }, { reason: 'field_type', s: (s) => { s.jobs['run100-2'][0].run_attempt = { toString: 1 }; } },
    { reason: 'field_type', s: (s) => { s.jobs['run100-1'][0].completed_at = '2026-13-45T99:00:00Z'; } }],
  job_files_coherent: [{ reason: 'mixed_run_attempt', s: (s) => { s.jobs['run100-1'].push(s.jobs['run200-1'].pop()); } }],
  job_name_unique: [{ reason: 'ambiguous_job_name', s: (s) => { s.checks.push(check({ id: 5 })); s.jobs['run100-1'].push(job({ id: 5 })); } }],
  status_consistent: [{ reason: 'check_not_completed', s: (s) => { s.checks[0].status = 'in_progress'; } }, { reason: 'check_not_completed', s: (s) => { s.checks[3].status = 'in_progress'; } },
    { reason: 'job_not_completed', s: (s) => { s.jobs['run100-1'][0].status = 'queued'; } }, { reason: 'conclusion_mismatch', s: (s) => { s.jobs['run100-2'][0].conclusion = 'failure'; } }],
  outcomes_known: [{ reason: 'check_conclusion_unknown', s: (s) => { s.checks[1].conclusion = null; } }, { reason: 'check_conclusion_unknown', s: (s) => { delete s.checks[1].conclusion; s.jobs['run100-2'][0].conclusion = null; } },
    { reason: 'check_conclusion_unknown', s: (s) => { s.checks[3].conclusion = 'bogus'; } }, { reason: 'job_conclusion_unknown', s: (s) => { s.jobs['run100-2'][0].conclusion = 'bogus'; } }],
  job_inputs_known: [{ reason: 'malformed_step', s: (s) => { s.jobs['run100-1'][0].steps = [null]; } }, { reason: 'malformed_step', s: (s) => { s.jobs['run100-1'][0].steps = [7]; } }, { reason: 'malformed_step', s: (s) => { s.jobs['run100-1'][0].steps = [{}]; } },
    { reason: 'malformed_step', s: (s) => { s.jobs['run100-1'][0].steps = [{ name: 'a', status: 'bogus', conclusion: null, number: 1 }]; } }, { reason: 'malformed_step', s: (s) => { s.jobs['run100-1'][0].steps = [{ name: 'a', status: 'queued', conclusion: null, number: 0 }]; } },
    { reason: 'malformed_step', s: (s) => { s.jobs['run100-1'][0].steps = [{ name: 'a', status: 'queued', conclusion: null, number: 1, extra: 1 }]; } }, { reason: 'malformed_step', s: (s) => { s.jobs['run100-2'][0].steps = 'x'; } },
    { reason: 'malformed_labels', s: (s) => { s.jobs['run100-1'][0].labels = [null]; } }, { reason: 'malformed_labels', s: (s) => { s.jobs['run100-1'][0].labels = [{ toString: 1 }]; } }, { reason: 'malformed_labels', s: (s) => { s.jobs['run100-1'][0].labels = 'x'; } },
    { reason: 'job_inputs_unknown', s: (s) => { delete s.jobs['run100-1'][0].steps; } }, { reason: 'job_inputs_unknown', s: (s) => { delete s.jobs['run100-1'][0].runner_name; } }],
  attempts_contiguous: [{ reason: 'attempt_gap', s: (s) => { s.checks.splice(0, 1); delete s.jobs['run100-1']; } }],
  no_orphan_jobs: [{ reason: 'not_bound', s: (s) => { s.jobs['run100-2'].push(job({ id: 77, name: 'x', run_attempt: 2, check_run_url: url(77) })); } }],
  annotations_complete: [{ reason: 'annotations_missing', s: (s) => { s.checks[0].output.annotations_count = 1; } }, { reason: 'annotations_unknown', s: (s) => { delete s.checks[3].output; } },
    { reason: 'annotations_incomplete', s: (s) => { s.checks[0].output.annotations_count = 2; s.annotations['1.jsonl'] = '{"message":"a"}\n'; } }],
};
// The EXACT state every reason must give (mandatory: a case whose reason is not listed fails).
const WANT = Object.fromEntries([
  ...['repo_malformed', 'sha_malformed', 'origin_malformed', 'file_not_regular_or_too_large', 'file_unreadable_or_not_utf8', 'entry_not_a_directory', 'dir_unreadable', 'unexpected_entry', 'root_not_a_real_directory',
    'annotation_file_unexpected', 'not_json_lines', 'unrecognised_line', 'name_not_string', 'annotation_not_an_annotation', 'too_deep', 'id_invalid', 'id_duplicate', 'mixed_run_attempt'].map((r) => [r, 'invalid']),
  ...['check_runs_missing', 'jobs_missing', 'no_total_count', 'total_count_disagree', 'items_differ_from_total', 'own_url_not_origin_repo', 'head_sha_mismatch', 'app_missing', 'own_id_mismatch', 'job_id_mismatch', 'no_job',
    'job_repo_mismatch', 'job_head_sha_mismatch', 'job_name_mismatch', 'job_identity_invalid', 'ambiguous_job_name', 'check_not_completed', 'job_not_completed', 'conclusion_mismatch', 'check_conclusion_unknown',
    'job_conclusion_unknown', 'job_inputs_unknown', 'malformed_step', 'malformed_labels', 'field_type', 'attempt_gap', 'not_bound', 'annotations_missing', 'annotations_incomplete', 'annotations_unknown'].map((r) => [r, 'incomplete']),
  ['no_check_runs', 'empty'],
]);
const observed = new Set(), skippedReasons = new Set();
const SKIPPABLE = ['EPERM', 'EACCES', 'ENOSYS', 'EOPNOTSUPP', 'UNKNOWN']; // the only symlink/chmod errors that mean "this platform or account cannot"

const hazard = (kind, root, dir) => {
  const cr = join(dir, 'check-runs.jsonl');
  if (kind === 'extra') writeFileSync(join(dir, 'notes.txt'), 'x');
  else if (kind === 'extra_in_jobs') writeFileSync(join(dir, 'jobs', 'notes.txt'), 'x');
  else if (kind === 'extra_in_annotations') writeFileSync(join(dir, 'annotations', 'notes.txt'), 'x');
  else if (kind === 'dircheck') { rmSync(cr); mkdirSync(cr); }
  else if (kind === 'oversized') truncateSync(cr, 64 * 1024 * 1024 + 1);
  else if (kind === 'badutf8') writeFileSync(cr, Buffer.concat([Buffer.from('{"total_count":1}\n{"id":1,"name":"v'), Buffer.from([0xff]), Buffer.from('"}\n')]));
  else if (kind === 'jobs_is_file') { rmSync(join(dir, 'jobs'), { recursive: true }); writeFileSync(join(dir, 'jobs'), 'x'); }
  else if (kind === 'nocheckfile') rmSync(cr);
  else if (kind === 'nojobsdir') rmSync(join(dir, 'jobs'), { recursive: true });
  else if (kind === 'missing_root') return join(root, 'nope');
  else if (kind === 'filelink' || kind.startsWith('symlink') || kind === 'unreadable') {
    try {
      if (kind === 'filelink') { writeFileSync(join(root, 'real.jsonl'), readFileSync(cr)); rmSync(cr); symlinkSync(join(root, 'real.jsonl'), cr); }
      else if (kind === 'unreadable') { if (process.platform === 'win32' || process.getuid?.() === 0) throw Object.assign(new Error('root or Windows ignores chmod'), { code: 'EPERM' }); chmodSync(join(dir, 'jobs'), 0); }
      else {
        const link = join(root, 'link'); symlinkSync(dir, link);
        return kind === 'symlink_slash' ? link + '/' : kind === 'symlink_dot' ? link + '/.' : kind === 'symlink_dotslash' ? link + '/./' : kind === 'symlink_updir' ? dir + '/../link' : kind === 'symlink_rel' ? { dir: './link', cwd: root } : link;
      }
    } catch (e) { if (SKIPPABLE.includes(e.code)) return { skip: `${kind}: ${e.code}` }; throw e; }
  }
  return dir;
};

test('validity: the baseline is snapshot_valid with no failed predicate, exits 0, and states what it does not attest', () => {
  const root = mkdtempSync(join(tmpdir(), 'cisnap-'));
  try {
    writeDir(root, base());
    const r = cli(root);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual([out.state, out.failed_predicates, out.reasons, out.origin], ['snapshot_valid', [], [], ORIGIN]);
    assert.deepEqual(out.not_attested, [...NOT_ATTESTED]); assert.ok(NOT_ATTESTED.length >= 5);
    assert.ok(NOT_ATTESTED.some((x) => x.startsWith('ci_outcome')) && NOT_ATTESTED.some((x) => x.startsWith('upstream_exhaustiveness')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const [predicate, list] of Object.entries(CASES)) {
  test(`validity: breaking ${predicate} makes the snapshot not snapshot_valid (state, exact reason, predicate, exit)`, (tc) => {
    const skipped = [];
    list.forEach((c, i) => {
      const root = mkdtempSync(join(tmpdir(), 'cisnap-'));
      let dir = join(root, 'snap');
      try {
        const s = base(); c.s?.(s);
        const x = texts(s); c.t?.(x);
        mkdirSync(dir); writeDir(dir, s, x);
        const d = c.root ? hazard(c.root, root, dir) : dir;
        if (d?.skip) { skipped.push(d.skip); skippedReasons.add(c.reason); return; }
        const r = spawnSync(process.execPath, [CLI, 'check', '--snapshot', d?.dir ?? d, '--repo', c.args?.repo ?? REPO, '--sha', c.args?.sha ?? SHA, '--origin', c.args?.origin ?? ORIGIN], { encoding: 'utf8', cwd: d?.cwd });
        const out = JSON.parse(r.stdout);
        const why = `${predicate}[${i}] ${c.reason}: ${out.reasons.join(',')}`;
        assert.ok(WANT[c.reason], `${why}: no WANT state`); assert.equal(out.state, WANT[c.reason], why); assert.equal(r.status, 1, why);
        assert.ok(out.reasons.some((q) => q === c.reason || q.endsWith(`_${c.reason}`)), why);
        assert.ok(out.failed_predicates.includes(predicate), why);
        assert.equal(out.internally_consistent, false, why);
        observed.add(c.reason);
      } finally { try { chmodSync(join(dir, 'jobs'), 0o755); } catch { /* absent */ } rmSync(root, { recursive: true, force: true }); }
    });
    if (skipped.length) tc.skip(`SKIPPED on this platform/account: ${skipped.join('; ')}`);
  });
}

test('validity registry: every predicate has cases, every site reason in SITES fired (or was explicitly skipped), nothing else is listed', () => {
  assert.deepEqual(Object.keys(CASES).sort(), [...PREDICATES].sort());
  assert.deepEqual(Object.keys(SITES).sort(), [...PREDICATES].sort());
  for (const [p, reasons] of Object.entries(SITES)) for (const r of reasons) {
    assert.ok(observed.has(r) || skippedReasons.has(r), `${p}/${r}: no table case fired this site`);
    assert.ok(CASES[p].some((c) => c.reason === r), `${p}/${r}: no case names it`);
  }
  assert.ok(CONCLUSIONS.includes('startup_failure') && !CONCLUSIONS.includes('bogus'));
});

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
  assert.equal(idStr('01'), null); assert.equal(idStr('0'), '0'); assert.equal(checkRunRef('https://api.github.com/repos/a/b/check-runs/01', ORIGIN), null);
});

test('rows carry the raw classification inputs with explicit absent/null/string markers (S-05b needs them)', () => {
  const s = base();
  s.jobs['run100-1'][0].steps = [{ name: 'a', status: 'completed', conclusion: 'failure', number: 1 }]; s.jobs['run100-1'][0].runner_name = 'host'; s.jobs['run100-1'][0].started_at = '2026-11-16T21:28:16Z';
  const a = row(build(s), 1).job_inputs;
  assert.deepEqual([a.runner_name_state, a.runner_name, a.steps, a.started_at, a.status, a.conclusion, a.run_attempt], ['string', 'host', [{ name: 'a', status: 'completed', conclusion: 'failure', number: 1 }], '2026-11-16T21:28:16Z', 'completed', 'failure', 1]);
  const b = row(build(), 1).job_inputs; // runner_name "" is a string, distinguishable from null and absent
  assert.deepEqual([b.runner_name_state, b.runner_name, b.steps_state], ['string', '', 'array']);
  const n = base(); n.jobs['run100-1'][0].runner_name = null; delete n.jobs['run100-1'][0].steps;
  const c = build(n).jobs.find((j) => j.id === '1');
  assert.deepEqual([c.inputs.runner_name_state, c.inputs.steps_state, c.inputs_unknown], ['null', 'absent', true]);
});

test('two provider installations cannot be mixed: another origin is not bound, a GHES base path works', () => {
  const s = base();
  const ghes = JSON.parse(JSON.stringify(s).replaceAll('https://api.github.com', 'https://ghe.example:8443/api/v3'));
  assert.equal(buildSnapshot({ texts: texts(ghes), repo: REPO, sha: SHA, origin: 'https://ghe.example:8443/api/v3/' }).state, 'snapshot_valid');
  assert.notEqual(buildSnapshot({ texts: texts(ghes), repo: REPO, sha: SHA, origin: ORIGIN }).state, 'snapshot_valid');
  assert.notEqual(buildSnapshot({ texts: texts(ghes), repo: REPO, sha: SHA, origin: 'https://ghe.example/api/v3' }).state, 'snapshot_valid'); // port matters
});

test('terminology: the module and its header never use the ambiguous `complete` as a state or field name', () => {
  const src = readFileSync(fileURLToPath(new URL('./ci-snapshot.mjs', import.meta.url)), 'utf8');
  const old = ['binding', 'complete'].join('_');
  assert.equal(src.includes(old), false);
  assert.equal(new RegExp('[\'"`]complete[\'"`]').test(src), false, 'a quoted "complete" state value');
  assert.equal(new RegExp('state[^\\n]{0,24}\\bcomplete\\b').test(src), false, '`state ... complete` in prose or code');
  assert.equal(new RegExp('\\bcomplete is never').test(src), false);
  assert.match(src, /snapshot_valid/); assert.match(src, /internally_consistent/); assert.match(src, /not_attested/);
  const s = build();
  assert.deepEqual([s.state, s.internally_consistent, Object.hasOwn(s, old)], ['snapshot_valid', true, false]);
  assert.ok(['snapshot_valid', 'incomplete', 'empty', 'invalid'].includes(build(base(), { checkRuns: nl([]) }).state));
});

test('malformed steps and labels keep their type information: different malformed entries never collapse to one value', () => {
  const s = base(); s.jobs['run100-1'][0].steps = [null, 7, {}, 'x', [1], { name: 'a', status: 'bogus', conclusion: null, number: 1 }]; s.jobs['run100-1'][0].labels = [null, { toString: 1 }];
  const snap = build(s);
  const inp = snap.jobs.find((j) => j.id === '1').inputs;
  assert.deepEqual([inp.steps_state, inp.labels_state, inp.labels], ['malformed', 'malformed', null]);
  assert.deepEqual(inp.steps.map((x) => [x.malformed, x.type]), [[true, 'null'], [true, 'number'], [true, 'object'], [true, 'string'], [true, 'array'], [true, 'object']]);
  assert.equal(new Set(inp.steps.map((x) => x.type + x.problem)).size, 6);
  assert.ok(snap.reasons.includes('job_1_malformed_step') && snap.reasons.includes('job_1_malformed_labels'));
  assert.equal(snap.state, 'incomplete');
  const ok = build(); const good = ok.jobs.find((j) => j.id === '2').inputs;
  assert.deepEqual(good.steps, [{ name: 's', status: 'completed', conclusion: 'success', number: 1 }]);
});

test('shape validator: closed schema, scalars, optional keys', () => {
  assert.equal(shapeProblem({ name: 'a', status: 'queued', conclusion: null, number: 1, started_at: null }, SHAPES.step), null);
  assert.equal(shapeProblem({ name: 'a', status: 'queued', conclusion: null }, SHAPES.step), '$.number:missing');
  assert.equal(shapeProblem(['a', 'b'], SHAPES.labels), null);
  assert.equal(shapeProblem(['a', 1], SHAPES.labels), '$[1]:bad_type');
  assert.equal(shapeProblem({ message: 'm', title: null }, SHAPES.annotation), null);
  assert.equal(shapeProblem({ message: 'm', x: 1 }, SHAPES.annotation), '$.x:unknown_key');
});

// ---- THE INVARIANT: every field the module reads is declared in SHAPES, and every declared field is validated -----------
// A rich synthetic snapshot in which EVERY declared field is populated, and which is snapshot_valid.
const TSV = '2026-11-16T21:28:16Z';
const rich = () => {
  const s = base();
  Object.assign(s.checks[0], { started_at: TSV, completed_at: TSV, output: { annotations_count: 1 } });
  Object.assign(s.jobs['run100-1'][0], { started_at: TSV, completed_at: TSV, runner_group_name: 'g', labels: ['self-hosted'], steps: [{ name: 's', status: 'completed', conclusion: 'failure', number: 1, started_at: TSV, completed_at: TSV }] });
  s.annotations['1.jsonl'] = JSON.stringify({ path: 'a', start_line: 1, end_line: 1, start_column: null, end_column: null, annotation_level: 'failure', title: null, message: 'm', raw_details: null, blob_href: 'h' }) + '\n';
  return s;
};

// declared reads, derived from SHAPES with the same kind-path scheme the recorder uses
const DECLARED = new Map(), SPECS = new Map();
for (const root of ['check_run', 'job', 'annotation', 'page']) (function walk(kind, spec) {
  if (spec.object) { DECLARED.set(kind, new Set(Object.keys(spec.object))); SPECS.set(kind, spec.object); for (const [k, s] of Object.entries(spec.object)) if (typeof s === 'object') walk(`${kind}.${k}`, s); }
  else if (spec.arrayOf && typeof spec.arrayOf === 'object') walk(`${kind}[]`, spec.arrayOf);
})(root, SHAPES[root]);
// Read but not a consumed value: the line-kind discriminators of a paginated page (`name` / `id` tell an item from a total_count line).
// A line that is neither an item nor a page (a stray object) is also asked for `total_count` by the same discriminator.
const UNCONSUMED_BUT_PRESERVED = { page: ['name', 'id'], check_run: ['total_count'], job: ['total_count'] };

const ARRAY_BUILTINS = ['length', 'map', 'slice', 'every', 'some', 'filter', 'forEach', 'includes', 'indexOf', 'join', 'find', 'findLast', 'at', 'entries', 'keys', 'values', 'flat', 'reduce', 'concat', 'constructor']; // constructor: read by Array.prototype.map (species lookup)
/** Run the module over `texts` with every raw object wrapped in a recording Proxy. reads = every read; biz = reads made by the business code (not by the shape validator or the traversal helpers). */
function recordReads(texts, reads, biz, enums) {
  const tag = new Map(), orig = JSON.parse;
  const kindOf = (line, itemKind) => { let o; try { o = orig(line); } catch { return itemKind; } if (!o || typeof o !== 'object') return itemKind; return Object.hasOwn(o, 'total_count') && !Object.hasOwn(o, 'name') ? 'page' : itemKind; };
  const add = (text, itemKind) => { for (const l of text.split('\n')) if (l.trim()) tag.set(l, kindOf(l, itemKind)); };
  add(texts.checkRuns, 'check_run');
  for (const v of Object.values(texts.jobs)) add(v, 'job');
  for (const v of Object.values(texts.annotations)) for (const l of v.split('\n')) if (l.trim()) tag.set(l, 'annotation');
  const rec = (kind, k, isArray) => {
    if (typeof k !== 'string' || (isArray && (/^\d+$/.test(k) || ARRAY_BUILTINS.includes(k)))) return;
    const stack = new Error().stack;
    if (/at (depthOf|canon|sha256)\b/.test(stack)) return;
    (reads.get(kind) ?? reads.set(kind, new Set()).get(kind)).add(k);
    if (!/at shapeProblem\b/.test(stack)) (biz.get(kind) ?? biz.set(kind, new Set()).get(kind)).add(k);
  };
  const ENUM_FRAME = /at Function\.(keys|values|entries|assign)\b/;
  const wrap = (v, kind) => new Proxy(v, {
    get(t, k, r) {
      const x = Reflect.get(t, k, r);
      rec(kind, k, Array.isArray(t));
      if (x && typeof x === 'object') return Array.isArray(t) ? (/^\d+$/.test(String(k)) ? wrap(x, `${kind}[]`) : x) : (typeof k === 'string' ? wrap(x, `${kind}.${k}`) : x);
      return x;
    },
    has(t, k) { rec(kind, k, Array.isArray(t)); return Reflect.has(t, k); },
    // Key ENUMERATION is not a read of a named field; it is recorded separately, and business-code enumeration (not the validator, not the traversal helpers) is what the test forbids.
    ownKeys(t) { const stack = new Error().stack; if (!/at (depthOf|canon|sha256|shapeProblem)\b/.test(stack)) enums.add(kind); return Reflect.ownKeys(t); },
    getOwnPropertyDescriptor(t, k) { if (!ENUM_FRAME.test(new Error().stack)) rec(kind, k, Array.isArray(t)); return Reflect.getOwnPropertyDescriptor(t, k); },
  });
  JSON.parse = (text, ...rest) => { const v = orig(text, ...rest); const kind = tag.get(text); return kind && v && typeof v === 'object' ? wrap(v, kind) : v; };
  try { return buildSnapshot({ texts, repo: REPO, sha: SHA, origin: ORIGIN }); } finally { JSON.parse = orig; }
}
// Each run keeps the (possibly mutated) TEXTS it will be recorded with; a mutated case must differ from the baseline text, or it silently became a baseline run.
const allRuns = () => {
  const baseText = JSON.stringify(texts(base()));
  const runs = [{ label: 'rich', x: texts(rich()) }, { label: 'base', x: texts(base()) }];
  for (const [pred, list] of Object.entries(CASES)) list.forEach((c, i) => {
    if (c.root || c.args) return;
    const s = base(); c.s?.(s); const x = texts(s); c.t?.(x);
    assert.notEqual(JSON.stringify(x), baseText, `${pred}[${i}] ${c.reason} is identical to the baseline text: the mutation was lost`);
    runs.push({ label: `${pred}[${i}]`, x });
  });
  return runs;
};
// Declared but only VALIDATED (typed, never read by a business function): the checks of their type is all this module does with them.
const VALIDATED_ONLY = { 'job.steps[]': ['started_at', 'completed_at'], annotation: ['path', 'start_line', 'end_line', 'start_column', 'end_column', 'annotation_level', 'title', 'raw_details', 'blob_href'] };

test('invariant: every property READ (get/has/descriptor lookup) by business code or the validator is declared in SHAPES, and business code never enumerates raw keys; business code reads every declared field except the explicit validated-only list', () => {
  const reads = new Map(), biz = new Map(), enums = new Set();
  for (const r of allRuns()) recordReads(r.x, reads, biz, enums);
  assert.deepEqual([...enums], [], 'business code enumerates the keys of a raw object (only the validator and traversal helpers may)');
  const undeclared = [];
  for (const [kind, keys] of reads) for (const k of keys) if (!DECLARED.get(kind)?.has(k) && !UNCONSUMED_BUT_PRESERVED[kind]?.includes(k)) undeclared.push(`${kind}.${k}`);
  assert.deepEqual(undeclared, []);
  const unread = [];
  for (const [kind, keys] of DECLARED) for (const k of keys) if (!biz.get(kind)?.has(k) && !VALIDATED_ONLY[kind]?.includes(k)) unread.push(`${kind}.${k}`);
  assert.deepEqual(unread, [], 'declared fields no business function reads (and not listed as validated-only)');
  for (const [kind, keys] of Object.entries(VALIDATED_ONLY)) for (const k of keys) assert.equal(biz.get(kind)?.has(k) ?? false, false, `${kind}.${k} is listed validated-only but is read: remove it from the list`);
  assert.ok(reads.get('job.steps[]').has('started_at') && !biz.get('job.steps[]').has('started_at')); // validator reads are attributed separately
});

test('invariant: a wrongly-typed value, or a missing required key, in ANY declared field is never snapshot_valid', () => {
  assert.equal(build(rich()).state, 'snapshot_valid');
  const HUGE = 'x'.repeat(100000), BAD = [{}, 7, true, [], '', HUGE, null, { toString: 1 }];
  const target = {
    check_run: (s) => s.checks[0], 'check_run.app': (s) => s.checks[0].app, 'check_run.output': (s) => s.checks[0].output,
    job: (s) => s.jobs['run100-1'][0], 'job.steps[]': (s) => s.jobs['run100-1'][0].steps[0],
  };
  const stat = { mutated: 0, specAccepts: 0, deleted: 0, optionalSkipped: 0 };
  const check = (label, spec, mutate) => { for (const bad of BAD) { if (shapeProblem(bad, spec) === null) { stat.specAccepts++; continue; } const s = rich(); const x = texts(s); mutate(s, x, bad); stat.mutated++; assert.notEqual(build(s, x).state, 'snapshot_valid', `${label} = ${typeof bad}`); } };
  const isOptional = (spec) => (typeof spec === 'string' ? spec.startsWith('?') : spec.optional === true);
  const del = (label, spec, mutate) => { if (isOptional(spec)) { stat.optionalSkipped++; return; } const s = rich(); const x = texts(s); mutate(s, x); stat.deleted++; assert.notEqual(build(s, x).state, 'snapshot_valid', `${label} deleted`); };
  for (const [kind, get] of Object.entries(target)) for (const [k, spec] of Object.entries(SPECS.get(kind))) {
    check(`${kind}.${k}`, spec, (s, x, bad) => { get(s)[k] = bad; Object.assign(x, texts(s)); });
    del(`${kind}.${k}`, spec, (s, x) => { delete get(s)[k]; Object.assign(x, texts(s)); });
  }
  const annoMut = (fn) => (s, x, bad) => { const o = JSON.parse(s.annotations['1.jsonl']); fn(o, bad); s.annotations['1.jsonl'] = JSON.stringify(o) + '\n'; Object.assign(x, texts(s)); };
  for (const [k, spec] of Object.entries(SPECS.get('annotation'))) { check(`annotation.${k}`, spec, annoMut((o, bad) => { o[k] = bad; })); del(`annotation.${k}`, spec, annoMut((o) => { delete o[k]; })); }
  check('page.total_count', SPECS.get('page').total_count, (s, x, bad) => { const l = x.checkRuns.split('\n'); l[0] = JSON.stringify({ total_count: bad }); x.checkRuns = l.join('\n'); });
  check('job.labels[0]', 'string', (s, x, bad) => { s.jobs['run100-1'][0].labels[0] = bad; Object.assign(x, texts(s)); });
  assert.deepEqual(stat, { mutated: 281, specAccepts: 71, deleted: 9, optionalSkipped: 33 }); // exact: a field added to SHAPES changes these deliberately
  assert.deepEqual([...DECLARED.keys()].sort(), ['annotation', 'check_run', 'check_run.app', 'check_run.output', 'job', 'job.steps[]', 'page']);
});

test('timestamps: impossible calendar dates are rejected in ALL six consumed fields by the native Date round trip; real instants pass', () => {
  const IMPOSSIBLE = ['2026-02-30T00:00:00Z', '2025-02-29T00:00:00Z', '2026-04-31T00:00:00Z', '2026-00-10T00:00:00Z', '2026-13-10T00:00:00Z', '2026-01-00T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T00:60:00Z', '2026-01-01T00:00:60Z', '2026-01-01T00:00:00+00:00', '2026-01-01 00:00:00Z'];
  const REAL = ['2024-02-29T23:59:59Z', '2026-11-16T21:28:16.123456789Z', '2026-12-31T23:59:59Z'];
  const slots = { 'check.started_at': (s, v) => { s.checks[0].started_at = v; }, 'check.completed_at': (s, v) => { s.checks[0].completed_at = v; }, 'job.started_at': (s, v) => { s.jobs['run100-1'][0].started_at = v; },
    'job.completed_at': (s, v) => { s.jobs['run100-1'][0].completed_at = v; }, 'step.started_at': (s, v) => { s.jobs['run100-1'][0].steps[0].started_at = v; }, 'step.completed_at': (s, v) => { s.jobs['run100-1'][0].steps[0].completed_at = v; } };
  for (const [slot, set] of Object.entries(slots)) {
    for (const v of IMPOSSIBLE) { const s = rich(); set(s, v); const snap = build(s); assert.equal(snap.state, 'incomplete', `${slot} ${v}`); assert.ok(snap.reasons.some((r) => r.endsWith('_field_type')), `${slot} ${v}`); }
    for (const v of REAL) { const s = rich(); set(s, v); assert.equal(build(s).state, 'snapshot_valid', `${slot} ${v}`); }
  }
});

test('SHAPES golden: the declared types are pinned (loosening a field type must be a deliberate edit of this digest)', () => {
  const digest = createHash('sha256').update(JSON.stringify(SHAPES)).digest('hex');
  assert.equal(digest, '7bc13ec6e1e91657ce39f62a35893dd71049cf1e6811d05a838ee2661ce57f2c');
  // the load-bearing types, spelled out so a reviewer can read them without hashing
  assert.equal(SHAPES.job.object.runner_name, '?string|null'); assert.equal(SHAPES.job.object.started_at, '?ts|null');
  assert.deepEqual(SHAPES.step.object.conclusion, { enum: CONCLUSIONS, nullable: true }); assert.equal(SHAPES.check_run.object.id, 'id');
});
