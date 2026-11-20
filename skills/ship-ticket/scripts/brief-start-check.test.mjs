import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planDigest, startCheck } from './brief.mjs';
import { planNarrativeDigest } from './engine-dag.mjs';
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
  multiple_blocks: `a${B}x${E}b${B}y${E}c`,
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
    const bad = run('start-check', '--plan', f);
    assert.equal(bad.status, 1);
    assert.deepEqual(JSON.parse(bad.stdout).errors.map((e) => e.code), ['start_approver_missing']);
    writeFileSync(f, withStart());
    assert.equal(run('start-check', '--plan', f, '--run-id', 'other').status, 1);
    assert.equal(readFileSync(f, 'utf8'), before);
    writeFileSync(f, 'no block\n');
    const none = run('start-check', '--plan', f);
    assert.equal(none.status, 1);
    assert.equal(JSON.parse(none.stdout).errors[0].code, 'plan_invalid');
    assert.equal(run('start-check').status, 2);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- negative controls: these must pass ----------------------------------------------------------------------------
test('start-check passes a correct START, a CRLF plan, and a START appended after the final narrative', () => {
  for (const text of [withStart(), withStart({}, NARRATIVE, '\r\n')]) {
    const r = startCheck(text);
    assert.deepEqual(r.errors, []);
    assert.equal(r.ok, true);
    assert.deepEqual(r.warnings, []);
  }
  // Append after the narrative is final: hash the finished narrative, then add the START inside the block.
  const finalNarrative = '# Plan\n\nfinal text\n\n';
  const empty = plan([], finalNarrative);
  const withEvent = plan([{ ...good(empty) }], finalNarrative);
  assert.equal(startCheck(withEvent, { runId: 'r1' }).ok, true);
});
test('start-check: legacy sha256- digest is a WARN, not a refusal', () => {
  const text = withStart({ approved_plan_digest: planDigest(plan()).replace('sha256:', 'sha256-') });
  const r = startCheck(text);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings.map((w) => w.code), ['start_digest_legacy']);
});

// ---- SCRUM-422 replays: each refused with its own code ------------------------------------------------------------------
test('SCRUM-422 replay 1: bare hex digest without the prefix', () => {
  const r = startCheck(withStart({ approved_plan_digest: planDigest(plan()).slice('sha256:'.length) }));
  assert.deepEqual(codes(r), ['start_digest_format']);
});
test('SCRUM-422 replay 1b: shasum-style 16 hex prefix', () => {
  assert.deepEqual(codes(startCheck(withStart({ approved_plan_digest: hex(plan()).slice(0, 16) }))), ['start_digest_format']);
});
test('SCRUM-422 replay 2: whole-file hash (shasum of the file before START was appended) instead of the narrative digest', () => {
  const before = plan([]); // the file a session hashed with shasum, then appended START to
  const text = plan([{ ...good(before), approved_plan_digest: `sha256:${hex(before)}` }]);
  assert.notEqual(`sha256:${hex(before)}`, planDigest(before)); // the template block holds comments, so the two differ
  assert.deepEqual(codes(startCheck(text)), ['start_digest_whole_file']);
});
test('SCRUM-422 replay 2b: a digest of some unrelated bytes is merely stale', () => {
  assert.deepEqual(codes(startCheck(withStart({ approved_plan_digest: `sha256:${hex('other')}` }))), ['start_digest_stale']);
});
test('SCRUM-422 replay 3: narrative edited after hashing', () => {
  const stamped = withStart();
  const edited = stamped.replace('Do the thing.', 'Do a different thing.');
  assert.deepEqual(codes(startCheck(edited)), ['start_digest_stale']);
});
test('SCRUM-422 replay 4: `at` instead of approved_at and no approver', () => {
  const r = startCheck(withStart({ approved_at: undefined, at: '2026-11-01T10:00:00Z', approved_by: undefined }));
  assert.deepEqual(codes(r), ['start_at_not_approved_at', 'start_approver_missing']);
});

// ---- the remaining field checks ---------------------------------------------------------------------------------------------
test('start-check: approved_at missing, not ISO-8601, in the future', () => {
  assert.deepEqual(codes(startCheck(withStart({ approved_at: undefined }))), ['start_approved_at_missing']);
  for (const bad of ['yesterday', '2026-11-01', '2026-13-45T10:00:00Z', 12345]) assert.deepEqual(codes(startCheck(withStart({ approved_at: bad }))), ['start_approved_at_invalid'], String(bad));
  assert.deepEqual(codes(startCheck(withStart({ approved_at: '2999-01-01T00:00:00Z' }))), ['start_approved_at_future']);
});
test('start-check: approved_by placeholders and agent identities are refused, a human name is not', () => {
  for (const by of ['<owner>', '<owner name>', 'TBD', 'todo', ' ']) {
    assert.ok(['start_approver_placeholder', 'start_approver_missing'].includes(codes(startCheck(withStart({ approved_by: by })))[0]), by);
  }
  for (const by of ['claude', 'Claude Opus', 'codex', 'Fable', 'orchestrator', 'sonnet-5.5', 'GPT-5', 'my-agent', 'ci_bot', 'Assistant']) {
    assert.deepEqual(codes(startCheck(withStart({ approved_by: by }))), ['start_approver_agent'], by);
  }
  for (const by of ['Ahmed Abdelfatah', 'botanist@example.org']) assert.equal(startCheck(withStart({ approved_by: by })).ok, true, by);
});
test('start-check: no START, wrong run id, and a missing digest field', () => {
  assert.deepEqual(codes(startCheck(plan([]))), ['start_missing']);
  assert.deepEqual(codes(startCheck(withStart(), { runId: 'nope' })), ['start_missing']);
  assert.deepEqual(codes(startCheck(withStart({ approved_plan_digest: undefined }))), ['start_digest_missing']);
  assert.throws(() => startCheck('no block'), /plan_invalid/);
});
test('start-check: the last START of the run is the one checked', () => {
  const t = plan([{ ...good(plan()), approved_by: 'claude' }, good(plan())]);
  assert.equal(startCheck(t).ok, true);
});

// ---- mutation proofs: break one check in a COPY of brief.mjs and show the replayed defect slips through ----------------
async function mutant(find, replace) {
  const src = readFileSync(SELF, 'utf8');
  assert.ok(src.includes(find), `mutation anchor missing: ${find}`);
  const path = join(fileURLToPath(new URL('.', import.meta.url)), `brief.mutant-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(path, src.replace(find, replace));
  try { return await import(pathToFileURL(path).href); } finally { unlinkSync(path); }
}
test('mutation: removing the stale-digest comparison lets the edited-narrative START through (so the real check bites)', async () => {
  const m = await mutant('else if (canon !== digest) {', 'else if (false) {');
  const edited = withStart().replace('Do the thing.', 'Do a different thing.');
  assert.equal(m.startCheck(edited).ok, true);
  assert.equal(startCheck(edited).ok, false);
});
test('mutation: removing the agent-identity check lets approved_by "claude" through', async () => {
  const m = await mutant('else if (tokens.some((t) => AGENT_TOKENS.includes(t)))', 'else if (false)');
  const t = withStart({ approved_by: 'claude' });
  assert.equal(m.startCheck(t).ok, true);
  assert.equal(startCheck(t).ok, false);
});
test('mutation: dropping the `at` distinction collapses its code into the generic missing-field code', async () => {
  const m = await mutant("start.at !== undefined ? 'start_at_not_approved_at'", "false ? 'start_at_not_approved_at'");
  const t = withStart({ approved_at: undefined, at: '2026-11-01T10:00:00Z' });
  assert.deepEqual(codes(m.startCheck(t)), ['start_approved_at_missing']);
  assert.deepEqual(codes(startCheck(t)), ['start_at_not_approved_at']);
});
