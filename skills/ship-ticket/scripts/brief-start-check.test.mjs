import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planDigest, startCheck } from './brief.mjs';
const chk = (text, o = {}) => startCheck(text, { runId: 'r1', ...o });
import { planNarrativeDigest, normDigest } from './engine-dag.mjs';
import { runStateEvents } from './run-state.mjs';
import { malformedRunState } from './engine-authority.mjs';
import { planDigest as securityPlanDigest } from './security-plan.mjs';

const CLI = fileURLToPath(new URL('./brief.mjs', import.meta.url));
const SELF = fileURLToPath(new URL('./brief.mjs', import.meta.url));
const B = '<!-- RUN-STATE:BEGIN -->', E = '<!-- RUN-STATE:END -->';
const hex = (s) => createHash('sha256').update(s).digest('hex');
const NARRATIVE = '# Plan\n\nDo the thing.\n\n';
const plan = (events = [], narrative = NARRATIVE, eol = '\n') =>
  (narrative + [B, ...events.map((e) => JSON.stringify(e)), E, ''].join('\n')).replace(/\n/g, eol);
const good = (text = plan()) => ({
  run_id: 'r1', event: 'START', approved_plan_digest: planDigest(text), approved_at: '2026-11-01T10:00:00Z', approved_by: 'Ahmed Abdelfatah',
});
const withStart = (over = {}, narrative = NARRATIVE, eol = '\n') => {
  const base = good(plan([], narrative, eol));
  const start = { ...base, ...over };
  for (const k of Object.keys(start)) if (start[k] === undefined) delete start[k];
  return plan([start], narrative, eol);
};
const codes = (r) => r.errors.map((e) => e.code);

// ---- parity ----------------------------------------------------------------------------------------------------
const WELL_FORMED = {
  lf: `a\n${B}\nx\n${E}\nz\n`,
  crlf: `a\r\n${B}\r\nx\r\n${E}\r\nz\r\n`,
  one_block_with_events: plan([{ run_id: 'r1', event: 'START' }]),
  empty_body: `a\n${B}${E}\n`,
};
test('plan digest: the three implementations agree on every well-formed RUN-STATE block', () => {
  for (const [name, text] of Object.entries(WELL_FORMED)) {
    const a = planNarrativeDigest(text);
    assert.match(a, /^sha256:[0-9a-f]{64}$/, name);
    assert.equal(planDigest(text), a, `brief ${name}`);
    assert.equal(securityPlanDigest(text), a, `security-plan ${name}`);
  }
});
// Two BEGIN/END pairs hash identically in all three copies, but the engine refuses such a plan as run_state_malformed
// (start-check does too, see the malformed tests below); parity on the digest alone is all this pins.
test('plan digest: two BEGIN/END pairs still hash identically in all three copies', () => {
  const text = `a${B}x${E}b${B}y${E}c`;
  assert.equal(planDigest(text), planNarrativeDigest(text));
  assert.equal(securityPlanDigest(text), planNarrativeDigest(text));
});
test('plan digest: CRLF and LF twins hash differently in all three (no line-end normalisation, documented)', () => {
  const lf = WELL_FORMED.lf, crlf = lf.replace(/\n/g, '\r\n');
  for (const f of [planNarrativeDigest, planDigest, securityPlanDigest]) assert.notEqual(f(lf), f(crlf));
  assert.equal(planDigest(WELL_FORMED.crlf), planNarrativeDigest(WELL_FORMED.crlf));
});
test('plan digest: the RUN-STATE body does not change the digest, the narrative does', () => {
  assert.equal(planDigest(plan([])), planDigest(plan([{ event: 'START', run_id: 'x' }])));
  assert.notEqual(planDigest(plan([])), planDigest(plan([], NARRATIVE + 'edit\n')));
});
// KNOWN DIFFERENCE, pinned on purpose. security-plan.mjs `narrative()` falls back to hashing the whole text when the
// block is absent or its markers are reversed, because its other callers (countBlocks, planNarrative at :316/:328) depend
// on that fallback. engine-dag.mjs (authoritative) and brief.mjs throw plan_invalid. plan-digest and start-check follow
// the engine: never a fallback hash. Do not "fix" security-plan.mjs to match without auditing those callers.
test('plan digest: no block, reversed markers or empty input: engine and brief throw plan_invalid, security-plan hashes the whole text', () => {
  for (const text of ['a\nb\n', `${E}a${B}`, '']) {
    assert.throws(() => planNarrativeDigest(text), /plan_invalid/);
    assert.throws(() => planDigest(text), /plan_invalid/);
    assert.equal(securityPlanDigest(text), `sha256:${hex(text)}`);
  }
});

// ---- CLI -------------------------------------------------------------------------------------------------------
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
test('plan-digest CLI prints exactly sha256:<64 hex> and nothing else', () => {
  const d = mkdtempSync(join(tmpdir(), 'sc-'));
  try {
    const f = join(d, 'p.md');
    writeFileSync(f, WELL_FORMED.crlf);
    const r = run('plan-digest', '--plan', f);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, `${planNarrativeDigest(WELL_FORMED.crlf)}\n`);
    writeFileSync(f, 'no block\n');
    const bad = run('plan-digest', '--plan', f);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /plan_invalid/);
    assert.equal(run('plan-digest').status, 2);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('start-check CLI: typed JSON on stdout, exit 0 ok, exit 1 refusal, plan without a block is plan_invalid, read-only', () => {
  const d = mkdtempSync(join(tmpdir(), 'sc-'));
  try {
    const f = join(d, 'p.md');
    writeFileSync(f, withStart());
    const before = readFileSync(f, 'utf8');
    const ok = run('start-check', '--plan', f, '--run-id', 'r1');
    assert.equal(ok.status, 0);
    assert.equal(JSON.parse(ok.stdout).ok, true);
    writeFileSync(f, withStart({ approved_by: undefined }));
    const bad = run('start-check', '--plan', f, '--run-id', 'r1');
    assert.equal(bad.status, 1);
    assert.deepEqual(JSON.parse(bad.stdout).errors.map((e) => e.code), ['start_approver_missing']);
    writeFileSync(f, withStart());
    assert.equal(run('start-check', '--plan', f, '--run-id', 'other').status, 1);
    assert.equal(readFileSync(f, 'utf8'), before);
    writeFileSync(f, 'no block\n');
    const none = run('start-check', '--plan', f, '--run-id', 'r1');
    assert.equal(none.status, 1);
    assert.equal(JSON.parse(none.stdout).errors[0].code, 'plan_invalid');
    assert.equal(run('start-check').status, 2);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- negative controls: these must pass ----------------------------------------------------------------------------
test('start-check passes a correct START, a CRLF plan, and a START appended after the final narrative', () => {
  for (const text of [withStart(), withStart({}, NARRATIVE, '\r\n')]) {
    const r = chk(text);
    assert.deepEqual(r.errors, []);
    assert.equal(r.ok, true);
    assert.deepEqual(r.warnings, []);
  }
  // Append after the narrative is final: hash the finished narrative, then add the START inside the block.
  const finalNarrative = '# Plan\n\nfinal text\n\n';
  const empty = plan([], finalNarrative);
  const withEvent = plan([{ ...good(empty) }], finalNarrative);
  assert.equal(chk(withEvent, { runId: 'r1' }).ok, true);
});
test('start-check: legacy sha256- digest is a WARN, not a refusal', () => {
  const text = withStart({ approved_plan_digest: planDigest(plan()).replace('sha256:', 'sha256-') });
  const r = chk(text);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings.map((w) => w.code), ['start_digest_legacy']);
});

// ---- SCRUM-422 replays: each refused with its own code ------------------------------------------------------------------
test('SCRUM-422 replay 1: bare hex digest without the prefix', () => {
  const r = chk(withStart({ approved_plan_digest: planDigest(plan()).slice('sha256:'.length) }));
  assert.deepEqual(codes(r), ['start_digest_format']);
});
test('SCRUM-422 replay 1b: shasum-style 16 hex prefix has its own code, distinct from bare hex', () => {
  assert.deepEqual(codes(chk(withStart({ approved_plan_digest: hex(plan()).slice(0, 16) }))), ['start_digest_truncated']);
});
test('SCRUM-422 replay 2: whole-file hash (shasum of the file before START was appended) instead of the narrative digest', () => {
  const before = plan([]); // the file a session hashed with shasum, then appended START to
  const text = plan([{ ...good(before), approved_plan_digest: `sha256:${hex(before)}` }]);
  assert.notEqual(`sha256:${hex(before)}`, planDigest(before)); // the template block holds comments, so the two differ
  assert.deepEqual(codes(chk(text)), ['start_digest_whole_file']);
});
test('SCRUM-422 replay 2b: a digest of some unrelated bytes is merely stale', () => {
  assert.deepEqual(codes(chk(withStart({ approved_plan_digest: `sha256:${hex('other')}` }))), ['start_digest_stale']);
});
test('SCRUM-422 replay 3: narrative edited after hashing', () => {
  const stamped = withStart();
  const edited = stamped.replace('Do the thing.', 'Do a different thing.');
  assert.deepEqual(codes(chk(edited)), ['start_digest_stale']);
});
test('SCRUM-422 replay 4: `at` instead of approved_at and no approver', () => {
  const r = chk(withStart({ approved_at: undefined, at: '2026-11-01T10:00:00Z', approved_by: undefined }));
  assert.deepEqual(codes(r), ['start_at_not_approved_at', 'start_approver_missing']);
});

// ---- the remaining field checks ---------------------------------------------------------------------------------------------
test('start-check: approved_at missing, not ISO-8601, in the future', () => {
  assert.deepEqual(codes(chk(withStart({ approved_at: undefined }))), ['start_approved_at_missing']);
  for (const bad of ['yesterday', '2026-11-01', '2026-13-45T10:00:00Z', 12345]) assert.deepEqual(codes(chk(withStart({ approved_at: bad }))), ['start_approved_at_invalid'], String(bad));
  assert.deepEqual(codes(chk(withStart({ approved_at: '2999-01-01T00:00:00Z' }))), ['start_approved_at_future']);
});
test('start-check: approved_by placeholders and agent identities are refused, a human name is not', () => {
  for (const by of ['<owner>', '<owner name>', 'TBD', 'todo', 'N/A', ' ']) {
    assert.ok(['start_approver_placeholder', 'start_approver_missing'].includes(codes(chk(withStart({ approved_by: by })))[0]), by);
  }
  for (const by of ['claude', 'Claude Opus', 'codex', 'Fable', 'orchestrator', 'sonnet-5.5', 'GPT-5', 'claude3', 'GPT5', 'ClaudeCode', 'opus4.1']) {
    assert.deepEqual(codes(chk(withStart({ approved_by: by }))), ['start_approver_agent'], by);
  }
  for (const by of ['Ahmed Abdelfatah', 'Li Na', 'Agent Smith', 'Bot Jones', 'Ana Todorova', 'Ian None']) assert.equal(chk(withStart({ approved_by: by })).ok, true, by);
});
test('start-check: no START, wrong run id, and a missing digest field', () => {
  assert.deepEqual(codes(chk(plan([]))), ['start_missing']);
  assert.deepEqual(codes(chk(withStart(), { runId: 'nope' })), ['start_missing']);
  assert.deepEqual(codes(chk(withStart({ approved_plan_digest: undefined }))), ['start_digest_missing']);
  assert.throws(() => chk('no block'), /plan_invalid/);
});
test('start-check: the last START of the run is the one checked', () => {
  const t = plan([{ ...good(plan()), approved_by: 'claude' }, good(plan())]);
  assert.equal(chk(t).ok, true);
});

// ---- mutation proofs: break one check in a COPY of brief.mjs and show the replayed defect slips through ----------------
async function mutant(find, replace) {
  let src = readFileSync(SELF, 'utf8');
  assert.ok(src.includes(find), `mutation anchor missing: ${find}`);
  const here = new URL('.', import.meta.url).href;
  src = src.replace(find, replace).replace(/from '\.\//g, `from '${here}`); // sibling imports become absolute: the copy lives in os.tmpdir()
  const dir = mkdtempSync(join(tmpdir(), 'sc-mut-'));
  const path = join(dir, 'brief.mjs');
  writeFileSync(path, src);
  try { return await import(pathToFileURL(path).href); } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('mutation: removing the stale-digest comparison lets the edited-narrative START through (so the real check bites)', async () => {
  const m = await mutant('else if (canon !== digest) {', 'else if (false) {');
  const edited = withStart().replace('Do the thing.', 'Do a different thing.');
  assert.equal(m.startCheck(edited, { runId: 'r1' }).ok, true);
  assert.equal(chk(edited).ok, false);
});
test('mutation: removing the agent-identity check lets approved_by "claude" through', async () => {
  const m = await mutant('else if (runs.some((r) => AGENT_TOKENS.some((t) => r.startsWith(t))))', 'else if (false)');
  const t = withStart({ approved_by: 'claude' });
  assert.equal(m.startCheck(t, { runId: 'r1' }).ok, true);
  assert.equal(chk(t).ok, false);
});
test('mutation: dropping the `at` distinction collapses its code into the generic missing-field code', async () => {
  const m = await mutant("start.at !== undefined ? 'start_at_not_approved_at'", "false ? 'start_at_not_approved_at'");
  const t = withStart({ approved_at: undefined, at: '2026-11-01T10:00:00Z' });
  assert.deepEqual(codes(m.startCheck(t, { runId: 'r1' })), ['start_approved_at_missing']);
  assert.deepEqual(codes(chk(t)), ['start_at_not_approved_at']);
});

// ---- review repair (S3a-1 round 2) -----------------------------------------------------------------------------------
test('B1: a malformed RUN-STATE block is refused as run_state_malformed, like the engine', () => {
  const start = JSON.stringify(good(plan()));
  const cases = {
    'non-JSON brace line': `${NARRATIVE}${B}\n${start}\n{not json\n${E}\n`,
    'bare CR hidden line break': `${NARRATIVE}${B}\n${start}\r{"event":"X"}\n${E}\n`,
    'second BEGIN/END pair': `${NARRATIVE}${B}\n${start}\n${E}\n${B}\n${E}\n`,
  };
  for (const [name, text] of Object.entries(cases)) {
    const r = chk(text);
    assert.equal(r.ok, false, name);
    assert.deepEqual(codes(r), ['run_state_malformed'], name);
    assert.ok(r.errors[0].message.length > 10, name);
  }
});
test('B1: start-check and the engine agree on malformed (same functions)', async () => {
  const { malformedRunState } = await import('./engine-authority.mjs');
  const text = `${NARRATIVE}${B}\n{bad\n${E}\n`;
  assert.equal(malformedRunState(text).length, 1);
  assert.deepEqual(codes(chk(text)), ['run_state_malformed']);
});
test('B2: --run-id is required (CLI exit 2, API throws); a START without a safe run_id is start_run_id_missing', () => {
  const d = mkdtempSync(join(tmpdir(), 'sc-'));
  try {
    const f = join(d, 'p.md');
    writeFileSync(f, withStart());
    assert.equal(run('start-check', '--plan', f).status, 2);
  } finally { rmSync(d, { recursive: true, force: true }); }
  assert.throws(() => startCheck(withStart()), /run-id/);
  assert.deepEqual(codes(chk(withStart({ run_id: undefined }))), ['start_run_id_missing']);
  assert.deepEqual(codes(chk(withStart({ run_id: '../x' }))), ['start_run_id_missing']);
  assert.deepEqual(codes(chk(withStart({ run_id: 'other' }))), ['start_missing']);
});
test('M1: a timestamp-only START is accepted with a start_timestamp_legacy warning; `at` alone is still refused', () => {
  const r = chk(withStart({ approved_at: undefined, timestamp: '2026-11-01T10:00:00Z' }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings.map((w) => w.code), ['start_timestamp_legacy']);
  assert.deepEqual(codes(chk(withStart({ approved_at: undefined, timestamp: 'junk' }))), ['start_approved_at_invalid']);
  assert.deepEqual(codes(chk(withStart({ approved_at: undefined, at: '2026-11-01T10:00:00Z' }))), ['start_at_not_approved_at']);
});
test('L1: placeholders match the whole value; agent identities by prefix of each run, with digits', () => {
  assert.equal(chk(withStart({ approved_by: 'Li Na' })).ok, true);
  assert.deepEqual(codes(chk(withStart({ approved_by: 'tbd' }))), ['start_approver_placeholder']);
  assert.deepEqual(codes(chk(withStart({ approved_by: 'Claude3' }))), ['start_approver_agent']);
});
test('L2: 5 minutes of clock skew is allowed, more is the future; impossible dates are invalid', () => {
  const now = Date.parse('2026-11-01T10:00:00Z');
  assert.equal(chk(withStart({ approved_at: '2026-11-01T10:04:00Z' }), { now }).ok, true);
  assert.deepEqual(codes(chk(withStart({ approved_at: '2026-11-01T10:06:00Z' }), { now })), ['start_approved_at_future']);
  for (const bad of ['2026-02-30T10:00:00Z', '2026-04-31T10:00:00Z', '2026-11-01T25:00:00Z']) {
    assert.deepEqual(codes(chk(withStart({ approved_at: bad }))), ['start_approved_at_invalid'], bad);
  }
});
test('L3: an unreadable plan is typed JSON plan_unreadable (exit 1); an unknown positional is a usage error', () => {
  const d = mkdtempSync(join(tmpdir(), 'sc-'));
  try {
    for (const target of [join(d, 'missing.md'), d]) {
      const r = run('start-check', '--plan', target, '--run-id', 'r1');
      assert.equal(r.status, 1);
      assert.equal(JSON.parse(r.stdout).errors[0].code, 'plan_unreadable');
    }
    const f = join(d, 'p.md');
    writeFileSync(f, withStart());
    assert.equal(run('start-check', '--plan', f, '--run-id', 'r1', 'extra').status, 2);
    assert.equal(run('plan-digest', '--plan', f, 'extra').status, 2);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- differential test against the engine's own approval logic (run-engine.mjs approvedPlan, rebuilt from its parts) ----
function engineAccepts(text, runId) {
  if (text.indexOf(B) < 0) return false;
  if (malformedRunState(text).length) return false;
  const digest = planNarrativeDigest(text);
  const start = runStateEvents(text).filter((e) => e.event === 'START').filter((e) => e.run_id === runId).at(-1);
  return Boolean(start) && normDigest(start.approved_plan_digest) === digest;
}
test('differential: start-check ok implies the engine accepts; they differ only where start-check is stricter', () => {
  const good1 = withStart();
  const dg = planDigest(plan());
  const S = (o) => withStart(o);
  const cases = {
    good: good1,
    crlf: withStart({}, NARRATIVE, '\r\n'),
    'trailing whitespace on the START line': good1.replace('}\n' + E, '}   \n' + E),
    'non-JSON START text': `${NARRATIVE}${B}\nSTART run r1\n${E}\n`,
    'two STARTs same run, last wins': plan([{ ...good(), approved_by: 'claude' }, good()]),
    'two STARTs same run, last bad': plan([good(), { ...good(), approved_plan_digest: 'sha256:' + hex('x') }]),
    'STARTs across runs': plan([{ ...good(), run_id: 'r2', approved_plan_digest: 'sha256:' + hex('x') }, good()]),
    'legacy sha256-': S({ approved_plan_digest: dg.replace('sha256:', 'sha256-') }),
    'uppercase hex': S({ approved_plan_digest: 'sha256:' + dg.slice(7).toUpperCase() }),
    'bare hex': S({ approved_plan_digest: dg.slice(7) }),
    stale: good1.replace('Do the thing.', 'Do other.'),
    'no run_id': S({ run_id: undefined }),
    'other run only': S({ run_id: 'r9' }),
    'bad approver': S({ approved_by: undefined }),
    'timestamp only': S({ approved_at: undefined, timestamp: '2026-11-01T10:00:00Z' }),
    'non-JSON brace line': `${NARRATIVE}${B}\n${JSON.stringify(good())}\n{nope\n${E}\n`,
    'bare CR': `${NARRATIVE}${B}\n${JSON.stringify(good())}\r{"event":"X"}\n${E}\n`,
    'second pair': `${NARRATIVE}${B}\n${JSON.stringify(good())}\n${E}\n${B}\n${E}\n`,
    'no block': 'plain\n',
    'reversed markers': `${E}\n${B}\n`,
    'missing digest': S({ approved_plan_digest: undefined }),
    'future': S({ approved_at: '2999-01-01T00:00:00Z' }),
    'STARTs only in another run with good digest': plan([{ ...good(), run_id: 'r2' }]),
  };
  let stricter = 0;
  for (const [name, text] of Object.entries(cases)) {
    let mine;
    try { mine = chk(text).ok; } catch { mine = false; }
    const eng = engineAccepts(text, 'r1');
    if (mine) assert.equal(eng, true, `start-check accepted what the engine refuses: ${name}`);
    if (eng && !mine) stricter += 1;
  }
  assert.ok(stricter >= 2, 'start-check is expected to be stricter on approver and future time');
});
