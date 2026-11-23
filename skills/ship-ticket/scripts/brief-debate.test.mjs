// S4: the restored reciprocal Planning Debate. `brief.mjs debate-check`, the plan-resident attestation, the START debate
// fields of `start-check`, the retained bundle, the Plan Mode logging deferral and the PLAN carrier probe classifier.
// Run alone: node --test skills/ship-ticket/scripts/brief-debate.test.mjs
//
// The probe tests below drive a FAKE relay. They prove the probe's parser and classifier only. They are not evidence
// that the real codex-delegate relay works inside native Plan Mode: that stays UNVERIFIED until the manual probe in
// references/codex-cli.md runs in a real Plan Mode session.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, readdirSync, statSync, existsSync, chmodSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import * as B from './brief.mjs';
import { parseRunState, malformedReason, runStateEvents } from './run-state.mjs';
import { planNarrativeDigest } from './engine-dag.mjs';

const CLI = fileURLToPath(new URL('./brief.mjs', import.meta.url));
const RUN_LOG = fileURLToPath(new URL('./run-log.mjs', import.meta.url));
const SELF = CLI;
const win = process.platform === 'win32';
/** The probe's no-op answer: a counterpart-response-v1 AGREE for request_id probe-<nonce>. */
const PROBE_MSG = (n) => JSON.stringify({ v: 1, request_id: `probe-${n}`, plan_version: 'v1', plan_digest: `sha256:${'0'.repeat(64)}`, verdict: 'AGREE', findings: [] });
const POSIX_ONLY = win && 'the fake relay and process-group checks are POSIX only';
const BEGIN = '<!-- RUN-STATE:BEGIN -->', END = '<!-- RUN-STATE:END -->';
const sha = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const codes = (r) => r.errors.map((e) => e.code);
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
/** The target repository every fixture debate ran in (workdir_kind repo binds the relay workdir to its top level). */
function gitRepo(prefix) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  for (const args of [['init', '-q'], ['config', 'user.email', 'p@example.invalid'], ['config', 'user.name', 'p'], ['config', 'commit.gpgsign', 'false']]) assert.equal(spawnSync('git', ['-C', d, ...args]).status, 0);
  writeFileSync(join(d, 'a.txt'), 'a\n');
  mkdirSync(join(d, 'skills'));
  writeFileSync(join(d, 'skills', 'b.txt'), 'b\n');
  assert.equal(spawnSync('git', ['-C', d, 'add', '-A']).status, 0);
  assert.equal(spawnSync('git', ['-C', d, 'commit', '-qm', 'base']).status, 0);
  return d;
}
const REPO = gitRepo('debate-target-');
after(() => rmSync(REPO, { recursive: true, force: true }));
const WORKDIR = REPO;
const TICKET = 'T-1';
const DEBATE_ID = 'debate-T-1-20261122T1000Z';
const CUT = Date.parse(B.DEBATE_POLICY_CUTOFF);
const iso = (ms) => new Date(ms).toISOString();
const AFTER = Number.isFinite(CUT) ? iso(CUT + 60_000) : 'cutoff-missing'; // a new run: approved after the S4 cutoff (guarded so RED fails per test, not at load)
const NOW = CUT + 120_000;
const PAST = '2026-11-22T10:30:00Z'; // a policy-2 plan is checked whatever its approval date; a real past instant keeps the CLI clock honest

function tmp(t, prefix = 'debate-') {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

// ---- the plan narrative --------------------------------------------------------------------------------------------
// Section 7 Markdown is human-readable only. The authority is the one `debate-dispositions-v1:` line; `narrative()` leaves
// a placeholder for it and the helpers (withResult) finalize it with the attestation outcome.
const DISPO_PENDING = 'debate-dispositions-v1: @@PENDING@@';
const NARR_OPTS = new Map();
const humanTable = (rows, fence = false) => (rows.length ? [...(fence ? ['```text'] : []), '| Finding | Disposition | Resolution | Design change |', '|---|---|---|---|',
  ...rows.map((r) => `| ${r.join(' | ')} |`), ...(fence ? ['```'] : []), ''].join('\n') : '');
function narrative({ policy = 'debate_policy: 2', attestationRef = `Attestation: ${DEBATE_ID}`, carrier = {}, rows = [], body = 'Do the thing.', fenceRows = false } = {}) {
  const text = ['---', 'run_id: r1', ...(policy ? [policy] : []), '---', '# Plan — T-1: thing', '', body, '',
    '## 7. Cross-model planning debate', '', 'Human-readable ledger (non-authoritative).', '', humanTable(rows, fenceRows), DISPO_PENDING, '',
    '## 8. Proof and review routing', '', 'x', '', ''].join('\n');
  NARR_OPTS.set(text, { attestationRef, carrier, rows });
  return text;
}
/** The dispositions object a narrative's options describe (rows: [id, kind, resolution, design 'yes'|'no'|other]). */
function dispoFrom({ attestationRef, carrier = {}, rows = [] }, outcome) {
  const c = { degraded: false, degradationAck: 'none', exception: 'none', reason: 'none', exceptionAck: 'none', scope: 'this ticket', ...carrier };
  return {
    v: 1, debate_id: attestationRef ? attestationRef.replace(/^Attestation:\s*/, '') : DEBATE_ID, outcome, carrier_degraded: c.degraded === true || c.degraded === 'true',
    degradation_ack: c.degradationAck === 'none' ? null : c.degradationAck,
    exception: c.exception === 'none' ? null : { kind: c.exception, reason: c.reason, scope: c.scope, ack: c.exceptionAck },
    dispositions: rows.map(([id, kind, resolution, design]) => ({ id, kind, resolution, design_change: design === 'yes' ? true : design === 'no' ? false : design })),
  };
}
const planText = (narr, lines = []) => `${narr}${[BEGIN, ...lines, END, ''].join('\n')}`;
/** Finalize the dispositions line of a narrative() text with `outcome` (a text without the placeholder is returned as is). */
const withResult = (narr, outcome, extra = {}) => {
  if (!narr.includes(DISPO_PENDING)) return narr;
  const opts = NARR_OPTS.get(narr) ?? [...NARR_OPTS].find(([k]) => narr.startsWith(k.slice(0, k.indexOf(DISPO_PENDING))))?.[1] ?? {};
  return narr.replace(DISPO_PENDING, B.serializeDispositions({ ...dispoFrom(opts, outcome), ...extra }));
};
const digestOf = (narr) => B.planDigest(planText(narr));

// ---- the bundle: relay evidence files at bundle-relative paths ------------------------------------------------------
const OLD_DIGEST = 'sha256:' + 'e'.repeat(64);
/** A counterpart-response-v1 object in its canonical bytes (schema key order, compact). */
function respond({ verdict = 'AGREE', request_id, plan_version, plan_digest, findings }) {
  const fs = findings.map((f) => Object.fromEntries(['id', 'status', 'severity', 'note'].filter((k) => Object.hasOwn(f, k)).map((k) => [k, f[k]])));
  return JSON.stringify({ v: 1, request_id, plan_version, plan_digest, verdict, findings: fs });
}
/**
 * Write one round's evidence under <bundle>/r<n>/ and return its attestation record. `kind` picks the carrier shape.
 * Options model the defects: a result that says something else than the record, a missing file, a dispatch failure.
 */
function round(bundle, n, o = {}) {
  const kind = o.kind ?? 'codex_relay';
  const request_id = o.request_id ?? `req-${n}`;
  const plan_version = o.plan_version ?? `v${n}`;
  const plan_digest = o.plan_digest ?? OLD_DIGEST;
  const status = o.status ?? 'completed';
  const verdict = o.verdict ?? (status === 'completed' ? 'CHANGES_REQUESTED' : null);
  const session = o.session ?? 'thread-1';
  const dir = join(bundle, `r${n}`);
  mkdirSync(dir, { recursive: true });
  const rec = { n, plan_version, request_id, status, session_id: session, read_only: o.read_only ?? true, out_dir: `/tmp/relay-out/r${n}`, started_at: o.started_at ?? '2026-11-22T10:00:00Z', ended_at: o.ended_at ?? '2026-11-22T10:05:00Z', files: {}, sha256: {}, verdict };
  rec.plan_digest = plan_digest;
  if (o.exit_code !== undefined) rec.exit_code = o.exit_code; else rec.exit_code = status === 'completed' ? 0 : 1;
  if (o.dispatch_error) { rec.dispatch_error = o.dispatch_error; rec.files = {}; rec.sha256 = {}; delete rec.session_id; return rec; }
  const briefText = o.brief ?? [`request_id: ${request_id}`, `plan_version: ${plan_version}`, `plan_digest: ${plan_digest}`, '', 'Challenge the plan.'].join('\n');
  const findings = o.findings ?? (verdict === 'AGREE' ? (o.concede ?? ['P1']).map((id) => ({ id, status: 'confirmed' })) : [{ id: 'P1', status: 'new', severity: 'major' }]);
  const message = o.message ?? (status === 'completed' ? respond({ verdict, request_id: o.echo_request_id ?? request_id, plan_version, plan_digest: o.echo_digest ?? plan_digest, findings }) : '');
  const put = (name, file, text) => { writeFileSync(join(dir, file), text); rec.files[name] = `r${n}/${file}`; rec.sha256[name] = sha(Buffer.from(text)); };
  if (kind === 'native_session') {
    put('message', 'message.txt', message);
    return rec;
  }
  put('brief', 'brief.txt', briefText);
  const resultStatus = o.result_status ?? (status === 'unavailable' ? 'codex_unavailable' : status);
  const result = kind === 'claude_relay'
    ? { schema: 1, tool: 'claude', workdir: o.workdir ?? WORKDIR, readOnly: o.readOnly ?? true, sessionId: o.result_session ?? session, status: resultStatus, exitCode: o.result_exit ?? rec.exit_code, finalMessage: message }
    : { schema: 1, workdir: o.workdir ?? WORKDIR, sandbox: o.sandbox ?? 'read-only', threadId: o.result_session ?? session, status: resultStatus, exitCode: o.result_exit ?? rec.exit_code, finalMessage: message, ...(status !== 'completed' || o.result_error ? { error: o.result_error ?? 'usage limit reached (429)' } : {}) };
  if (kind === 'claude_relay') rec.auth_method = o.auth_method ?? 'claude.ai';
  if (o.omitIds) { delete result.exitCode; delete result.threadId; delete result.sessionId; delete rec.exit_code; delete rec.session_id; }
  if (!o.noResult) put('result', 'result.json', JSON.stringify(result));
  put('events', 'events.jsonl', o.events ?? '{"type":"thread.started"}\n');
  if (o.noResult) { delete rec.files.result; delete rec.sha256.result; }
  return rec;
}

const FIND = (over = {}) => ({ id: 'P1', severity: 'major', status: 'resolved', aliases: [], host_position: 'accepted: changed D', counterpart_position: 'confirmed', closed_by: 'counterpart', closed_round: 2, evidence: 'r2 confirms', ...over });
function attestation(over = {}) {
  return {
    v: 1, debate_id: DEBATE_ID, ticket: TICKET, policy: 2, outcome: 'CONVERGED', plan_version: 'v2',
    workdir: WORKDIR, workdir_kind: 'repo',
    host: { agent: 'claude', identity: 'claude:opus-5-5' },
    carrier: { agent: 'codex', kind: 'codex_relay', identity: 'codex:gpt-5.5', degraded: false },
    budget: { max_rounds: null, max_minutes: null },
    metrics: { rounds: 2, calls: 2, minutes: 12, started_at: '2026-11-22T10:00:00Z', ended_at: '2026-11-22T10:12:00Z', tokens: null },
    contract_recheck: 'not_applicable', findings: [FIND()], rounds: [], final: null, limit: null, incomplete_review: false,
    ...over,
  };
}

/** A complete CONVERGED debate: round 1 CHANGES_REQUESTED, round 2 AGREE for the exact frozen digest. */
function converged(t, { narr: n0 = narrative(), over = {}, r2 = {}, r1 = {} } = {}) {
  const narr = withResult(n0, over.outcome ?? 'CONVERGED');
  const bundle = tmp(t, 'debate-bundle-');
  const D = digestOf(narr);
  const rounds = [round(bundle, 1, { plan_version: 'v1', ...r1 }), round(bundle, 2, { plan_version: 'v2', plan_digest: D, verdict: 'AGREE', request_id: 'req-final', ...r2 })];
  const att = attestation({ plan_digest: D, rounds, final: { request_id: 'req-final', plan_version: 'v2', plan_digest: D, verdict: 'AGREE' }, ...over });
  const line = B.serializeAttestation(att);
  return { bundle, D, att, line, narr, text: planText(narr, [line]) };
}
const pre = (x, text = x.text) => B.debateCheck(text, { bundleDir: x.bundle, repo: x.repo ?? REPO });

// ================================================================== serialization and the digest cycle
test('serialization: one deterministic comment line, key order independent, parses back to the same object', () => {
  const a = attestation({ plan_digest: 'sha256:' + '0'.repeat(64) });
  const reordered = Object.fromEntries(Object.entries(a).reverse());
  const line = B.serializeAttestation(a);
  assert.equal(B.serializeAttestation(reordered), line);
  assert.ok(line.startsWith('<!-- debate-attestation-v1 {'), line.slice(0, 40));
  assert.ok(line.endsWith('} -->'));
  assert.ok(!line.includes('\n') && !line.includes('\r'));
  const r = B.readAttestation(planText(narrative(), [line]));
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(r.attestation, JSON.parse(JSON.stringify(a)));
  assert.equal(r.line, line);
  assert.equal(r.sha256, sha(Buffer.from(line, 'utf8')), 'the exact serialized line bytes, without the line end, are hashed');
});

test('serialization escapes U+2028, U+2029, U+0085, RUN-STATE marker text and --> inside strings; the block stays well formed', () => {
  const nasty = `a b c\u0085d ${END} ${BEGIN} --> <!-- e`;
  const a = attestation({ plan_digest: 'sha256:' + '1'.repeat(64), findings: [FIND({ host_position: nasty, counterpart_position: nasty })] });
  const line = B.serializeAttestation(a);
  for (const raw of [' ', ' ', '\u0085', END, BEGIN, 'RUN-STATE:END -->', '<!-- RUN', ' --> ']) {
    assert.ok(!line.slice(4, -4).includes(raw), `raw ${JSON.stringify(raw)} survived inside the JSON`);
  }
  const narr = narrative();
  const text = planText(narr, [line]);
  const R = parseRunState(text);
  assert.equal(malformedReason(R), null, 'the block is not malformed');
  assert.equal(R.events.length, 0, 'the attestation line parses to no RUN-STATE event');
  assert.equal(B.planDigest(text), digestOf(narr), 'the attestation line leaves the narrative digest unchanged');
  assert.equal(planNarrativeDigest(text), digestOf(narr), 'the engine digest agrees');
  const back = B.readAttestation(text);
  assert.equal(back.ok, true);
  assert.equal(back.attestation.findings[0].host_position, nasty, 'the escaped strings decode to the original text');
});

test('a `{`-leading attestation line is refused (it would be a RUN-STATE event), as is a non-canonical or duplicated line', () => {
  const a = attestation({ plan_digest: 'sha256:' + '2'.repeat(64) });
  const raw = JSON.stringify({ 'debate-attestation-v1': a });
  const text = planText(narrative(), [raw]);
  assert.equal(runStateEvents(text).length, 1, 'why it is refused: the engine would read it as an event');
  assert.equal(B.readAttestation(text).error.code, 'debate_attestation_invalid');
  const line = B.serializeAttestation(a);
  const loose = line.replace('{"', '{ "');
  assert.equal(B.readAttestation(planText(narrative(), [loose])).error.code, 'debate_attestation_invalid', 'non-canonical bytes');
  assert.equal(B.readAttestation(planText(narrative(), [line, line])).error.code, 'debate_attestation_invalid', 'two lines');
  assert.equal(B.readAttestation(planText(narrative(), [`  ${line}`])).error.code, 'debate_attestation_invalid', 'leading whitespace');
  assert.equal(B.readAttestation(planText(narrative(), [])).error.code, 'debate_attestation_missing');
});

test('digest cycle: freeze, confirm the exact digest, record the attestation, START against the same digest', (t) => {
  const x = converged(t);
  assert.equal(B.planDigest(x.text), x.D, 'recording the attestation did not move the digest the counterpart confirmed');
  const r = pre(x);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'CONVERGED');
  assert.equal(r.debate_qualified, true);
  assert.equal(r.attestation_sha256, sha(Buffer.from(x.line)));
  const start = { run_id: 'r1', event: 'START', approved_plan_digest: x.D, approved_at: AFTER, approved_by: 'owner', debate_attestation_sha256: r.attestation_sha256 };
  const s = B.startCheck(planText(x.narr, [x.line, JSON.stringify(start)]), { runId: 'r1', now: NOW, bundleDir: retain(t, x), repo: REPO });
  assert.deepEqual(s.errors, []);
  assert.equal(s.ok, true);
});

// ================================================================== debate-check: CONVERGED and its refusals
test('CONVERGED refusals: different digest, edit after the last AGREE, open blocker, unverified hash', (t) => {
  const other = 'sha256:' + 'a'.repeat(64);
  const x1 = converged(t, { r2: { plan_digest: other }, over: {} });
  x1.att.final.plan_digest = other; x1.att.plan_digest = other;
  assert.ok(codes(pre(x1, planText(x1.narr, [B.serializeAttestation(x1.att)]))).includes('debate_digest_mismatch'), 'AGREE for another digest');
  const x2 = converged(t);
  const edited = planText(narrative({ body: 'Do another thing.' }), [x2.line]);
  assert.ok(codes(pre(x2, edited)).includes('debate_digest_mismatch'), 'a digest-changing edit after the last AGREE');
  const x3 = converged(t, { r1: { findings: [{ id: 'P1', status: 'new', severity: 'major' }, { id: 'P9', status: 'new', severity: 'blocker' }] },
    over: { findings: [FIND(), FIND({ id: 'P9', severity: 'blocker', status: 'open', closed_by: undefined, closed_round: undefined, evidence: undefined })] } });
  assert.ok(codes(pre(x3)).includes('debate_open_finding'), 'an AGREE that leaves a blocker open in the derived ledger');
  const x4 = converged(t);
  writeFileSync(join(x4.bundle, 'r2', 'result.json'), readFileSync(join(x4.bundle, 'r2', 'result.json'), 'utf8').replace('"status":"completed"', '"status":"completed" '));
  assert.ok(codes(pre(x4)).includes('debate_evidence_mismatch'), 'a result whose bytes no longer match the recorded hash');
  const x5 = converged(t, { r2: { noResult: true } });
  assert.ok(codes(pre(x5)).includes('debate_evidence_missing'), 'a completed round without its result file');
});

test('CONVERGED refusals: stale or foreign request_id, a replayed request_id, an AGREE only in prose', (t) => {
  const x1 = converged(t, { r2: { echo_request_id: 'req-1' } });
  assert.ok(codes(pre(x1)).includes('debate_request_mismatch'), 'the response echoes an older request');
  const x2 = converged(t, { r1: { request_id: 'req-final' } });
  assert.ok(codes(pre(x2)).includes('debate_request_mismatch'), 'two rounds share one request_id (replay)');
  const x3 = converged(t, { r2: { message: 'AGREE for plan_version v2. request_id req-final' } });
  assert.ok(codes(pre(x3)).includes('debate_response_invalid'), 'an AGREE in prose is not a response object');
  const D = digestOf(withResult(narrative(), 'CONVERGED'));
  const dup = respond({ request_id: 'req-final', plan_version: 'v2', plan_digest: D, findings: [{ id: 'P1', status: 'confirmed' }] }).replace('"v":1,', '"v":1,"v":1,');
  const x4 = converged(t, { r2: { message: dup } });
  assert.ok(codes(pre(x4)).includes('debate_response_invalid'), 'a duplicated key');
  const x5 = converged(t, { r2: { brief: 'request_id: other\nplan_version: v2\n' } });
  assert.ok(codes(pre(x5)).includes('debate_request_mismatch'), 'the brief that was sent carries another request');
});

test('CONVERGED refusals: a non-read-only or wrong-workdir result, a fabricated success record', (t) => {
  assert.ok(codes(pre(converged(t, { r2: { sandbox: 'workspace-write' } }))).includes('debate_carrier_invalid'));
  assert.ok(codes(pre(converged(t, { r2: { workdir: resolve(tmpdir(), 'elsewhere') } }))).includes('debate_carrier_invalid'));
  assert.ok(codes(pre(converged(t, { r2: { result_session: 'thread-9' } }))).includes('debate_carrier_invalid'), 'another thread answered');
  assert.ok(codes(pre(converged(t, { r2: { result_status: 'failed', result_exit: 1 } }))).includes('debate_evidence_mismatch'), 'record says completed, the relay says failed');
  const x = converged(t);
  x.att.contract_recheck = 'pending';
  assert.ok(codes(pre(x, planText(x.narr, [B.serializeAttestation(x.att)]))).includes('debate_outcome_invalid'), 'changed-contract compatibility not rechecked');
});

// ================================================================== UNRESOLVED, LIMIT_REACHED, SKIPPED, carriers
function unresolved(t, { narr: n0 = narrative(), over = {}, findings, r1 = {}, r2 = {}, r3 = null } = {}) {
  const narr = withResult(n0, 'UNRESOLVED');
  const bundle = tmp(t, 'debate-bundle-');
  const D = digestOf(narr);
  const rounds = [round(bundle, 1, { plan_version: 'v1', findings: [{ id: 'P3', status: 'new', severity: 'major' }], ...r1 }),
    round(bundle, 2, { plan_version: 'v2', plan_digest: 'sha256:' + 'b'.repeat(64), findings: r2.verdict === 'AGREE' ? [] : [{ id: 'P3', status: 'maintained' }], ...r2 }),
    ...(r3 ? [round(bundle, 3, { findings: r3.verdict === 'AGREE' ? [] : [{ id: 'P3', status: 'maintained' }], ...r3 })] : [])];
  const att = attestation({ outcome: 'UNRESOLVED', plan_digest: D, rounds, final: null,
    findings: findings ?? [FIND({ id: 'P3', status: 'open', closed_by: undefined, closed_round: undefined, host_position: 'keep A', counterpart_position: 'prefer B' })], ...over });
  const line = B.serializeAttestation(att);
  return { bundle, D, att, line, narr, text: planText(narr, [line]) };
}

test('UNRESOLVED is accepted for presentation (no deadlock) and is not debate-qualified', (t) => {
  const x = unresolved(t);
  const r = pre(x);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'UNRESOLVED');
  assert.equal(r.debate_qualified, false);
  assert.deepEqual(r.outstanding, ['P3']);
  const noPositions = unresolved(t, { findings: [FIND({ id: 'P3', status: 'open', closed_by: undefined, closed_round: undefined, counterpart_position: '' })] });
  assert.ok(codes(pre(noPositions)).includes('debate_outcome_invalid'), 'an outstanding finding needs both positions');
  const nothingOpen = unresolved(t, { findings: [FIND()] });
  assert.ok(codes(pre(nothingOpen)).includes('debate_outcome_invalid'), 'UNRESOLVED needs at least one outstanding finding');
});

function limited(t, { narr: n0 = narrative(), over = {}, roundOpts = {} } = {}) {
  const narr = withResult(n0, 'LIMIT_REACHED');
  const bundle = tmp(t, 'debate-bundle-');
  const D = digestOf(narr);
  const rounds = [round(bundle, 1, { plan_version: 'v1', status: 'failed', ...roundOpts })];
  const att = attestation({ outcome: 'LIMIT_REACHED', plan_digest: D, rounds, final: null, findings: [], incomplete_review: true,
    limit: { kind: 'provider_limit', evidence: roundOpts.dispatch_error?.text ?? 'usage limit reached (429)' }, metrics: { rounds: 0, calls: 1, minutes: 1, started_at: '2026-11-22T10:00:00Z', ended_at: '2026-11-22T10:01:00Z', tokens: null }, ...over });
  const line = B.serializeAttestation(att);
  return { bundle, D, att, line, narr, text: planText(narr, [line]) };
}

function skipped(t, { carrier } = {}) {
  const narr = withResult(narrative({ carrier: carrier ?? { exception: 'SKIPPED', reason: 'docs-only follow-up agreed with the owner', exceptionAck: B.SKIP_ACK } }), 'SKIPPED');
  const att = attestation({ outcome: 'SKIPPED', plan_digest: digestOf(narr), rounds: [], findings: [], final: null, metrics: { rounds: 0, calls: 0, minutes: 0, started_at: null, ended_at: null, tokens: null } });
  const line = B.serializeAttestation(att);
  return { bundle: tmp(t, 'debate-bundle-'), att, line, narr, D: digestOf(narr), text: planText(narr, [line]) };
}

test('SKIPPED needs the frozen owner exception in the plan; without it, it is refused', (t) => {
  const x = skipped(t);
  assert.deepEqual(pre(x).errors, []);
  assert.equal(pre(x).debate_qualified, false);
  assert.ok(codes(pre(skipped(t, { carrier: {} }))).includes('debate_exception_missing'), 'no exception');
  assert.ok(codes(pre(skipped(t, { carrier: { exception: 'SKIPPED', reason: 'x', exceptionAck: 'ok by me' } }))).includes('debate_exception_missing'), 'not the acknowledgement sentence');
  assert.ok(codes(pre(skipped(t, { carrier: { exception: 'SKIPPED', reason: 'x', exceptionAck: B.SKIP_ACK, scope: 'all tickets' } }))).includes('debate_exception_missing'), 'scope other than this ticket');
});

test('carrier.degraded: acknowledged Fable is a transport label; it does not qualify unresolved findings; same-provider is computed', (t) => {
  const fable = { agent: 'fable', kind: 'native_session', identity: 'claude:fable', degraded: true };
  const narr = withResult(narrative({ carrier: { degraded: true, degradationAck: B.DEGRADED_ACK } }), 'UNRESOLVED');
  const bundle = tmp(t, 'debate-bundle-');
  const rounds = [round(bundle, 1, { kind: 'native_session', plan_version: 'v1', session: 'host-session-1', findings: [{ id: 'P3', status: 'new', severity: 'major' }] })];
  const mk = (over) => planText(over.narr ? withResult(over.narr, 'UNRESOLVED') : narr, [B.serializeAttestation(attestation({ outcome: 'UNRESOLVED', plan_digest: digestOf(over.narr ? withResult(over.narr, 'UNRESOLVED') : narr), carrier: fable, rounds,
    findings: [FIND({ id: 'P3', status: 'open', closed_by: undefined, closed_round: undefined, host_position: 'A', counterpart_position: 'B' })], ...over.att }))]);
  const r = B.debateCheck(mk({}), { bundleDir: bundle, repo: REPO });
  assert.deepEqual(r.errors, []);
  assert.equal(r.debate_qualified, false);
  assert.equal(r.diversity, 'same_provider');
  assert.deepEqual(r.carrier, { agent: 'fable', kind: 'native_session', identity: 'claude:fable', degraded: true });
  assert.ok(codes(B.debateCheck(mk({ narr: narrative() }), { bundleDir: bundle, repo: REPO })).includes('debate_degradation_unacknowledged'));
  assert.ok(codes(B.debateCheck(mk({ att: { carrier: { ...fable, degraded: false } } }), { bundleDir: bundle, repo: REPO })).includes('debate_carrier_invalid'), 'Fable only as the declared substitute');
  assert.ok(codes(B.debateCheck(mk({ att: { outcome: 'DEGRADED' } }), { bundleDir: bundle, repo: REPO })).includes('debate_outcome_invalid'), 'DEGRADED is not an outcome');
});

test('Codex-host pairing: a Claude relay counterpart with subscription auth converges; api-key auth or a writable session is refused', (t) => {
  const claude = { agent: 'claude', kind: 'claude_relay', identity: 'claude:opus-5-5', degraded: false };
  const host = { agent: 'codex', identity: 'codex:gpt-5.5' };
  const x = converged(t, { over: { host, carrier: claude }, r1: { kind: 'claude_relay', session: 'sess-1' }, r2: { kind: 'claude_relay', session: 'sess-1' } });
  const r = pre(x);
  assert.deepEqual(r.errors, []);
  assert.equal(r.diversity, 'cross_provider');
  assert.ok(codes(pre(converged(t, { over: { host, carrier: claude }, r1: { kind: 'claude_relay', session: 's' }, r2: { kind: 'claude_relay', session: 's', auth_method: 'api_key' } }))).includes('debate_carrier_invalid'));
  assert.ok(codes(pre(converged(t, { over: { host, carrier: claude }, r1: { kind: 'claude_relay', session: 's' }, r2: { kind: 'claude_relay', session: 's', readOnly: false } }))).includes('debate_carrier_invalid'));
  assert.ok(codes(pre(converged(t, { over: { host: { agent: 'claude', identity: 'claude:opus-5-5' }, carrier: claude }, r1: { kind: 'claude_relay', session: 's' }, r2: { kind: 'claude_relay', session: 's' } }))).includes('debate_carrier_invalid'), 'a Claude host cannot use a non-degraded Claude counterpart');
});

test('plan-level refusals: no debate_policy, no attestation line, section 7 does not predeclare the attestation id', (t) => {
  const x = converged(t);
  assert.ok(codes(B.debateCheck(planText(narrative({ policy: null }), [x.line]), { bundleDir: x.bundle, repo: REPO })).includes('debate_policy_missing'));
  assert.ok(codes(B.debateCheck(planText(x.narr, []), { bundleDir: x.bundle, repo: REPO })).includes('debate_attestation_missing'));
  const y = converged(t, { narr: narrative({ attestationRef: 'Attestation: debate-T-1-20261122T0900Z' }) });
  assert.ok(codes(pre(y)).includes('debate_attestation_invalid'));
  const z = converged(t, { over: { debate_id: '../../etc' } });
  assert.ok(codes(pre(z)).includes('debate_attestation_invalid'), 'an unsafe debate id');
});

test('property: UNRESOLVED and LIMIT_REACHED are never refused solely because the counterpart did not AGREE', (t) => {
  const variants = [];
  for (const sev of ['blocker', 'major', 'minor']) {
    variants.push(unresolved(t, { r1: { findings: [{ id: 'P3', status: 'new', severity: sev }] }, findings: [FIND({ id: 'P3', severity: sev, status: 'open', closed_by: undefined, closed_round: undefined, evidence: undefined, host_position: 'h', counterpart_position: 'c' })] }));
  }
  for (const status of ['failed', 'timeout', 'aborted', 'unavailable']) variants.push(incomplete(t, { roundOpts: { status } }));
  for (const x of variants) {
    const r = pre(x);
    assert.deepEqual(r.errors, [], `${x.att.outcome} ${JSON.stringify(r.errors)}`);
    assert.equal(r.ok, true);
    assert.equal(r.debate_qualified, false);
  }
});

// ================================================================== retention and START
/** Retain the bundle for x in a fresh repository-like common dir and return the retained bundle directory. */
function retain(t, x) {
  const common = tmp(t, 'debate-common-');
  const dir = B.debateLocator(common, x.att.ticket, x.att.debate_id);
  const r = B.retainBundle(x.text, { from: x.bundle, to: dir, root: common, repo: REPO });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return dir;
}
const startLine = (x, over = {}) => {
  const s = { run_id: 'r1', event: 'START', approved_plan_digest: x.D, approved_by: 'owner', debate_attestation_sha256: sha(Buffer.from(x.line)), approved_at: PAST, ...over };
  for (const k of Object.keys(s)) if (s[k] === undefined) delete s[k];
  return JSON.stringify(s);
};
const sc = (text, bundleDir, o = {}) => B.startCheck(text, { runId: 'r1', now: NOW, bundleDir, repo: REPO, ...o });

test('the S4 cutoff is one parseable constant; before it a plan without debate_policy is legacy, from it on it is refused', () => {
  assert.ok(Number.isFinite(CUT), 'DEBATE_POLICY_CUTOFF parses');
  assert.ok(CUT >= Date.parse('2026-11-22T00:00:00Z'), 'the cutoff is not before the S4 debate itself');
  assert.equal(B.debateLegacyApproval({ approved_at: iso(CUT - 1) }), true);
  assert.equal(B.debateLegacyApproval({ timestamp: iso(CUT - 1000) }), true);
  assert.equal(B.debateLegacyApproval({ approved_at: iso(CUT) }), false, 'the cutoff itself is not legacy');
  assert.equal(B.debateLegacyApproval({ approved_at: 'yesterday' }), false, 'unparseable fails closed');
  assert.equal(B.debateLegacyApproval({ approved_at: '2026-11-01T10:00:00Z' }), true, 'the existing start-check fixtures stay legacy');
  const narr = narrative({ policy: null });
  const D = digestOf(narr);
  const legacy = planText(narr, [JSON.stringify({ run_id: 'r1', event: 'START', approved_plan_digest: D, approved_at: iso(CUT - 60_000), approved_by: 'o' })]);
  assert.deepEqual(sc(legacy, null).errors, []);
  assert.deepEqual(sc(legacy, null).warnings, [], 'a legacy plan gets no new warning');
  const fresh = planText(narr, [JSON.stringify({ run_id: 'r1', event: 'START', approved_plan_digest: D, approved_at: AFTER, approved_by: 'o' })]);
  assert.deepEqual(codes(sc(fresh, null)), ['debate_policy_missing']);
  const unknown = planText(narrative({ policy: 'debate_policy: 3' }), [JSON.stringify({ run_id: 'r1', event: 'START', approved_plan_digest: digestOf(narrative({ policy: 'debate_policy: 3' })), approved_at: iso(CUT - 60_000), approved_by: 'o' })]);
  assert.deepEqual(codes(sc(unknown, null)), ['debate_policy_missing'], 'an unknown policy value is never an implicit legacy fallback');
});

test('start-check for a policy-2 plan: the attestation hash is mandatory, changed bytes and a missing bundle are refused', (t) => {
  const x = converged(t);
  const dir = retain(t, x);
  assert.deepEqual(sc(planText(x.narr, [x.line, startLine(x)]), dir).errors, []);
  assert.deepEqual(codes(sc(planText(x.narr, [x.line, startLine(x, { debate_attestation_sha256: undefined })]), dir)), ['debate_attestation_missing'], 'START omits the hash');
  assert.deepEqual(codes(sc(planText(x.narr, [startLine(x)]), dir)), ['debate_attestation_missing'], 'the plan lost its attestation line');
  const changed = B.serializeAttestation({ ...x.att, metrics: { ...x.att.metrics, minutes: 99 } });
  assert.deepEqual(codes(sc(planText(x.narr, [changed, startLine(x)]), dir)), ['debate_attestation_changed'], 'the line was rewritten after approval');
  assert.deepEqual(codes(sc(planText(x.narr, [x.line, startLine(x)]), null)), ['debate_evidence_missing'], 'no retained bundle located');
  assert.deepEqual(codes(sc(planText(x.narr, [x.line, startLine(x)]), join(dir, 'nope'))), ['debate_evidence_missing']);
  // a START that is itself invalid keeps its exact single code: the debate fields are checked only on a valid approval time
  assert.deepEqual(codes(sc(planText(x.narr, [x.line, startLine(x, { approved_at: '2999-01-01T00:00:00Z' })]), dir)), ['start_approved_at_future']);
});

test('start-check: UNRESOLVED blocks START while a disposition is pending; concrete dispositions pass; a design change needs reconfirmation', (t) => {
  const go = (rows) => {
    const x = unresolved(t, { narr: narrative({ rows }) });
    return codes(sc(planText(x.narr, [x.line, startLine(x)]), retain(t, x)));
  };
  assert.deepEqual(go([]), ['debate_disposition_pending'], 'no disposition row');
  // a pending finding has NO row: `decide` / `re-debate` are not disposition kinds, so such a line is refused outright
  for (const kind of ['decide', 're-debate']) assert.ok(codes(pre(unresolved(t, { narr: narrative({ rows: [['P3', kind, 'later', 'no']] }) }))).includes('debate_attestation_invalid'), kind);
  assert.deepEqual(go([['P3', 'accept_risk', '', 'no']]), ['debate_disposition_pending'], 'empty resolution');
  assert.deepEqual(go([['P3', 'accept_risk', '<the accepted-risk text>', 'no']]), ['debate_disposition_pending'], 'a placeholder');
  assert.deepEqual(go([['P3', 'accept_risk', 'The owner accepts that B is not adopted for this ticket.', 'no']]), []);
  assert.deepEqual(go([['P3', 'decided', 'Keep A: the importer depends on it.', 'no']]), []);
  assert.deepEqual(go([['P3', 'decided', 'Adopt B.', 'yes']]), ['debate_reconfirm_required']);
  assert.deepEqual(go([['P3', 'waived', 'Out of scope by exception.', 'no']]), ['debate_disposition_pending'], 'waived needs the frozen exception');
});

test('start-check: LIMIT_REACHED needs an owner disposition of the limit; SKIPPED with its exception may START', (t) => {
  const lx = (rows) => { const x = limited(t, { narr: narrative({ rows }), over: { rounds: [], findings: [], incomplete_review: true, budget: { max_rounds: null, max_minutes: 1 }, metrics: { rounds: 0, calls: 0, minutes: 1, started_at: null, ended_at: null, tokens: null }, limit: { kind: 'configured_budget', evidence: 'max_minutes: 1' } } }); return codes(sc(planText(x.narr, [x.line, startLine(x)]), retain(t, x))); };
  assert.deepEqual(lx([]), ['debate_disposition_pending']);
  assert.deepEqual(lx([['LIMIT', 'accept_risk', 'The owner accepts planning without a counterpart review: quota exhausted.', 'no']]), []);
  const s = skipped(t);
  assert.deepEqual(codes(sc(planText(s.narr, [s.line, startLine(s)]), retain(t, s))), []);
});

test('recovery in a new session: the original scratch bundle is DELETED, verification uses only the retained bundle (CLI)', (t) => {
  const repo = tmp(t, 'debate-repo-');
  assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0);
  const x = converged(t, { over: { workdir: repo }, r1: { workdir: repo }, r2: { workdir: repo } });
  const planFile = join(repo, 'plan.md');
  writeFileSync(planFile, x.text);
  const kept = run('debate-retain', '--plan', planFile, '--bundle', x.bundle, '--repo', repo);
  assert.equal(kept.status, 0, kept.stdout + kept.stderr);
  const where = JSON.parse(kept.stdout).retained;
  assert.ok(where.includes(join('ai-skills', 'ship-ticket', 'debate', TICKET, DEBATE_ID)), where);
  rmSync(x.bundle, { recursive: true, force: true });
  assert.equal(existsSync(x.bundle), false);
  writeFileSync(planFile, planText(x.narr, [x.line, startLine(x)]));
  const ok = spawnSync(process.execPath, [CLI, 'start-check', '--plan', planFile, '--run-id', 'r1', '--repo', repo], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(JSON.parse(ok.stdout).ok, true);
  // the retained copy is byte-for-byte: tamper with it and START is refused
  writeFileSync(join(where, 'r2', 'events.jsonl'), 'tampered\n');
  const bad = spawnSync(process.execPath, [CLI, 'start-check', '--plan', planFile, '--run-id', 'r1', '--repo', repo], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.ok(JSON.parse(bad.stdout).errors.some((e) => e.code === 'debate_evidence_mismatch'));
});

test('debate-retain refuses a bundle that does not verify and never overwrites a different retained bundle', (t) => {
  const x = converged(t);
  const common = tmp(t, 'debate-common-');
  const dir = B.debateLocator(common, TICKET, DEBATE_ID);
  writeFileSync(join(x.bundle, 'r1', 'brief.txt'), 'changed');
  assert.equal(B.retainBundle(x.text, { from: x.bundle, to: dir, root: common, repo: REPO }).ok, false);
  assert.equal(existsSync(join(dir, 'attestation.line')), false, 'nothing was retained');
  const y = converged(t);
  assert.equal(B.retainBundle(y.text, { from: y.bundle, to: dir, root: common, repo: REPO }).ok, true);
  assert.equal(B.retainBundle(y.text, { from: y.bundle, to: dir, root: common, repo: REPO }).ok, true, 'idempotent for identical bytes');
  writeFileSync(join(dir, 'r1', 'brief.txt'), 'other');
  assert.equal(B.retainBundle(y.text, { from: y.bundle, to: dir, root: common, repo: REPO }).ok, false, 'a different retained bundle is never overwritten');
});

// ================================================================== CLI
test('debate-check and debate-serialize CLI: typed JSON, exit 0 presentable, exit 1 refused, exit 2 usage', (t) => {
  const x = converged(t);
  const d = tmp(t);
  const f = join(d, 'p.md');
  writeFileSync(f, x.text);
  const ok = run('debate-check', '--plan', f, '--bundle', x.bundle, '--repo', REPO);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(JSON.parse(ok.stdout).outcome, 'CONVERGED');
  writeFileSync(f, planText(x.narr, []));
  const bad = run('debate-check', '--plan', f, '--bundle', x.bundle, '--repo', REPO);
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).errors[0].code, 'debate_attestation_missing');
  assert.equal(run('debate-check', '--plan', f).status, 2);
  const j = join(d, 'a.json');
  writeFileSync(j, JSON.stringify(x.att));
  const ser = run('debate-serialize', '--attestation', j);
  assert.equal(ser.status, 0, ser.stderr);
  const [line, hashLine] = ser.stdout.trimEnd().split('\n');
  assert.equal(line, x.line);
  assert.equal(hashLine, `debate-attestation-sha256 ${sha(Buffer.from(x.line))}`);
});

// ================================================================== Plan Mode logging deferral
test('Plan Mode: debate-check has no logger path and writes nothing (plan, bundle and repository unchanged)', (t) => {
  const src = readFileSync(SELF, 'utf8');
  assert.ok(!/run-log/.test(src), 'brief.mjs never calls or imports the run logger');
  const repo = tmp(t, 'debate-repo-');
  assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0);
  const x = converged(t);
  const f = join(repo, 'plan.md');
  writeFileSync(f, x.text);
  const snap = (root) => {
    const out = [];
    const walk = (p) => { for (const n of readdirSync(p)) { const q = join(p, n); const s = statSync(q); if (s.isDirectory()) walk(q); else out.push(`${q}:${s.size}:${s.mtimeMs}`); } };
    walk(root);
    return out.sort().join('\n');
  };
  const before = [snap(repo), snap(x.bundle)];
  assert.equal(run('debate-check', '--plan', f, '--bundle', x.bundle, '--repo', REPO).status, 0);
  assert.deepEqual([snap(repo), snap(x.bundle)], before);
});

test('after approval the debate metrics replay through the real logger with CURRENT timestamps; history is only metric values', (t) => {
  const x = converged(t);
  const r = pre(x);
  assert.deepEqual(r.run_log_metrics, ['debate_outcome=converged', 'debate_carrier=codex', 'debate_carrier_degraded=false', 'debate_rounds=2', 'debate_calls=2',
    'debate_minutes=12', 'plan_debate_started_at=2026-11-22T10:00:00Z', 'plan_debate_ended_at=2026-11-22T10:12:00Z']);
  const repo = tmp(t, 'debate-repo-');
  assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0);
  const metricsFile = join(tmp(t), 'metrics.json');
  writeFileSync(metricsFile, JSON.stringify({ run_log_metrics: r.run_log_metrics }));
  const common = ['--repo', repo, '--ticket', TICKET, '--run-id', 'run-1', '--kind', 'phase', '--name', 'PLAN', '--event-id', 'phase-plan'];
  const t0 = Date.now();
  assert.equal(spawnSync(process.execPath, [RUN_LOG, 'start', ...common], { encoding: 'utf8' }).status, 0);
  const end = spawnSync(process.execPath, [RUN_LOG, 'end', ...common, '--outcome', 'pass', '--metrics-from', metricsFile], { encoding: 'utf8' });
  assert.equal(end.status, 0, end.stderr);
  const logs = spawnSync('git', ['-C', repo, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).stdout.trim();
  const found = [];
  const walk = (p) => { for (const n of readdirSync(p)) { const q = join(p, n); if (statSync(q).isDirectory()) walk(q); else if (/\.jsonl$/.test(n)) found.push(q); } };
  walk(resolve(repo, logs));
  const rows = found.flatMap((f) => readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
  const ended = rows.find((row) => row.metrics?.plan_debate_started_at);
  assert.ok(ended, 'the replayed metrics were logged');
  assert.ok(Date.parse(ended.timestamp) >= t0 - 1000, 'the logger stamped the current time, not the debate time');
  assert.equal(ended.metrics.plan_debate_started_at, '2026-11-22T10:00:00Z', 'the historical time is a labelled metric value');
  assert.ok(!rows.some((row) => row.timestamp === '2026-11-22T10:00:00Z'), 'no backdated event');
});

// ================================================================== PLAN carrier probe (classifier; fake relay)
test('probe classifier (pure): each capability is pass/fail with a failure class; dependent capabilities inherit a dispatch failure', () => {
  const okObs = { relay_present: true, codex_version: { status: 0 }, login: { status: 0 }, dispatch: { result: { status: 'completed', threadId: 'th-1', sandbox: 'read-only', finalMessage: PROBE_MSG('n1') } }, nonce: 'n1',
    resume: { result: { status: 'completed', threadId: 'th-1', sandbox: 'read-only' } }, cancel: { child_seen: true, result: { status: 'timeout' }, survivors: [] }, coverage: { before: 'c1', after: 'c1', ignored_before: 'i', ignored_after: 'i' } };
  const all = B.classifyProbe(okObs);
  for (const k of ['dispatch', 'fresh_result', 'resume', 'cancellation', 'coverage']) assert.equal(all[k].result, 'pass', k);
  assert.match(all.coverage.detail, /candidate identity and untracked-content hash unchanged; ignored files out of coverage/);
  const cls = (over) => B.classifyProbe({ ...okObs, ...over });
  assert.equal(cls({ relay_present: false }).dispatch.class, 'relay');
  assert.equal(cls({ codex_version: { error: 'EACCES' } }).dispatch.class, 'permission_denied');
  assert.equal(cls({ codex_version: { error: 'ENOENT' } }).dispatch.class, 'provider');
  assert.equal(cls({ login: { status: 1 } }).dispatch.class, 'auth');
  const blocked = cls({ dispatch: { spawn_error: 'EPERM' } });
  assert.equal(blocked.dispatch.class, 'permission_denied');
  for (const k of ['fresh_result', 'resume', 'cancellation']) assert.equal(blocked[k].result, 'fail', k);
  assert.equal(cls({ dispatch: { result: { status: 'failed', error: 'usage limit reached (429)' } } }).dispatch.class, 'provider');
  assert.equal(cls({ dispatch: { result: { status: 'failed', error: 'not logged in (401)' } } }).dispatch.class, 'auth');
  assert.equal(cls({ dispatch: { result: null } }).dispatch.class, 'relay');
  assert.equal(cls({ dispatch: { result: { status: 'completed', threadId: '', sandbox: 'read-only', finalMessage: PROBE_MSG('n1') } } }).fresh_result.result, 'fail');
  assert.equal(cls({ resume: { result: { status: 'completed', threadId: 'th-2', sandbox: 'read-only' } } }).resume.result, 'fail', 'resume must return the same thread');
  assert.equal(cls({ cancel: { child_seen: false, result: { status: 'failed' }, survivors: [] } }).cancellation.class, 'relay', 'failed before spawning: never a cancellation pass');
  assert.equal(cls({ cancel: { child_seen: false, result: { status: 'failed' }, survivors: [] } }).cancellation.result, 'fail');
  assert.equal(cls({ cancel: { child_seen: true, result: { status: 'timeout' }, survivors: [4242] } }).cancellation.result, 'fail', 'a surviving child process group');
  assert.equal(cls({ cancel: { child_seen: true, result: { status: 'completed' }, survivors: [] } }).cancellation.result, 'fail', 'no timeout happened');
  assert.equal(cls({ coverage: { before: 'c1', after: 'c2', ignored_before: 'i', ignored_after: 'i' } }).coverage.result, 'fail');
  assert.equal(cls({ coverage: { before: 'c1', after: 'c1', ignored_before: 'i', ignored_after: 'j' } }).coverage.result, 'fail', 'the ignored listing changed');
});

const FAKE_RELAY = `
import { writeFileSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
const a = process.argv.slice(2);
const get = (k) => { const i = a.indexOf(k); return i < 0 ? null : a[i + 1]; };
const out = get('--out-dir'); const cd = get('--cd'); const session = get('--session'); const timeout = get('--timeout');
const mode = process.env.FAKE_MODE || 'ok';
mkdirSync(out, { recursive: true });
let brief = ''; try { brief = readFileSync(0, 'utf8'); } catch {}
const claude = process.env.FAKE_CARRIER === 'claude';
const ver = spawnSync(claude ? 'claude' : 'codex', ['--version'], { encoding: 'utf8' });
const version = mode === 'other-cli' ? 'other 0.0.0' : String(ver.stdout || '').trim();
const write = (o) => {
  const { threadId, ...rest } = o;
  const shaped = claude ? { workdir: cd, readOnly: a.includes('--read-only'), sessionId: threadId, claudeVersion: version, ...rest } : { workdir: cd, sandbox: a.includes('--read-only') ? 'read-only' : 'workspace-write', threadId, codexVersion: version, ...rest };
  writeFileSync(join(out, 'result.json'), JSON.stringify(shaped));
};
if (mode === 'mutate') appendFileSync(join(cd, 'untracked.txt'), 'changed by the relay');
// like the real relay's \`codex --version\` and \`git status\` helpers: an ordinary, non-detached child in the relay's group
if (mode === 'helper') spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 400)']);
const rid = (/^request_id: (\\S+)$/m.exec(brief) || [])[1] || '';
if (/sleep/.test(brief)) {
  if (mode === 'fail-before-spawn') { write({ status: 'failed', exitCode: 1, error: 'spawn codex ENOENT' }); process.exit(1); }
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  child.unref();
  writeFileSync(join(out, 'pids'), process.pid + ' ' + child.pid);
  const ms = Number(String(timeout).replace(/s$/, '')) * 1000;
  setTimeout(() => {
    if (mode !== 'no-kill') { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    write({ status: 'timeout', exitCode: 124, threadId: 'th-busy' });
    process.exit(124);
  }, ms);
} else {
  const thread = session ? (mode === 'new-thread' ? 'th-other' : session) : 'th-fresh-1';
  write({ status: 'completed', exitCode: 0, threadId: thread, finalMessage: JSON.stringify({ v: 1, request_id: rid, plan_version: 'v1', plan_digest: 'sha256:' + '0'.repeat(64), verdict: 'AGREE', findings: [] }) });
}
`;
const FAKE_CODEX = (loginStatus) => `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.0.0-fake"; exit 0; fi\nif [ "$1" = "login" ]; then exit ${loginStatus}; fi\nexit 2\n`;
function probeFixture(t, { login = 0 } = {}) {
  const d = tmp(t, 'debate-probe-');
  const repo = join(d, 'repo');
  mkdirSync(repo);
  for (const args of [['init', '-q'], ['config', 'user.email', 'p@example.invalid'], ['config', 'user.name', 'p'], ['config', 'commit.gpgsign', 'false']]) assert.equal(spawnSync('git', ['-C', repo, ...args]).status, 0);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n');
  assert.equal(spawnSync('git', ['-C', repo, 'add', '-A']).status, 0);
  assert.equal(spawnSync('git', ['-C', repo, 'commit', '-qm', 'x']).status, 0);
  writeFileSync(join(repo, 'untracked.txt'), 'existing untracked content\n');
  const relay = join(d, 'relay.mjs');
  writeFileSync(relay, FAKE_RELAY);
  const codex = join(d, 'codex');
  writeFileSync(codex, FAKE_CODEX(login));
  chmodSync(codex, 0o755);
  return { d, repo, relay, codex, out: join(d, 'out') };
}
const probe = (f, mode, extra = [], env = {}) => spawnSync(process.execPath, [CLI, 'debate-probe', '--relay', f.relay, '--repo', f.repo, '--out-dir', f.out, '--cli', f.codex, '--busy-timeout', '1s', ...extra],
  { encoding: 'utf8', env: { ...process.env, FAKE_MODE: mode, ...env }, timeout: 60_000 });

test('probe with a FAKE relay (parser and classifier only, not real-relay evidence): every capability passes', { skip: POSIX_ONLY }, (t) => {
  const f = probeFixture(t);
  const r = probe(f, 'ok');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.relay_kind_verified, false, 'the probe never claims the relay is the real one');
  for (const k of ['dispatch', 'fresh_result', 'resume', 'cancellation', 'coverage']) assert.equal(out.codex_route[k].result, 'pass', `${k}: ${JSON.stringify(out.codex_route[k])}`);
});

test('probe with a FAKE relay: a non-detached helper child of the relay is not the cancellation target, and the probe survives', { skip: POSIX_ONLY }, (t) => {
  const f = probeFixture(t);
  const r = probe(f, 'helper');
  assert.equal(r.status, 0, `the probe must not kill its own process group: status ${r.status} signal ${r.signal} ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  for (const k of ['dispatch', 'fresh_result', 'resume', 'cancellation', 'coverage']) assert.equal(out.codex_route[k].result, 'pass', `${k}: ${JSON.stringify(out.codex_route[k])}`);
});

test('probe with a FAKE relay: auth, resume, surviving child, failure before spawn and an existing-untracked-file mutation are classified', { skip: POSIX_ONLY }, (t) => {
  const route = (f, mode) => JSON.parse(probe(f, mode).stdout).codex_route;
  assert.equal(route(probeFixture(t, { login: 1 }), 'ok').dispatch.class, 'auth');
  assert.equal(route(probeFixture(t), 'new-thread').resume.result, 'fail');
  const survivor = route(probeFixture(t), 'no-kill');
  assert.equal(survivor.cancellation.result, 'fail');
  assert.match(survivor.cancellation.detail, /process group/);
  const early = route(probeFixture(t), 'fail-before-spawn');
  assert.equal(early.cancellation.result, 'fail', 'a dispatch that fails before spawning is never a cancellation pass');
  const mutated = route(probeFixture(t), 'mutate');
  assert.equal(mutated.coverage.result, 'fail', 'an edit to an existing untracked file is detected by candidate identity');
});

// ================================================================== mutation evidence: each checker rule's mutant slips its defect through
async function mutant(find, replace) {
  let src = readFileSync(SELF, 'utf8');
  assert.ok(src.includes(find), `mutation anchor missing: ${find}`);
  assert.equal(src.split(find).length, 2, `mutation anchor not unique: ${find}`);
  const here = new URL('.', import.meta.url).href;
  src = src.replace(find, replace).replace(/from '\.\//g, `from '${here}`);
  const dir = mkdtempSync(join(tmpdir(), 'debate-mut-'));
  const path = join(dir, 'brief.mjs');
  writeFileSync(path, src);
  try { return await import(pathToFileURL(path).href); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const MUTANTS = [
  ['D-A10: LIMIT_REACHED only for a configured budget', "if (!isObject(L) || L.kind !== 'configured_budget' || !nonEmpty(L.evidence)) {", "if (L?.kind !== 'configured_budget') return; if (false) {",
    (t) => ({ x: limited(t, { roundOpts: { result_error: 'usage limit reached (429)' }, over: { limit: { kind: 'provider_limit', evidence: 'usage limit reached (429)' } } }), code: 'debate_limit_invalid' })],
  ['D-A10: an incomplete review needs a failed relay result', "else if (relay.status === 'completed' && relay.exitCode === 0) add('debate_outcome_invalid'", "else if (false) add('debate_outcome_invalid'",
    (t) => ({ x: incomplete(t, { roundOpts: { status: 'completed', verdict: 'AGREE', findings: [] } }), code: 'debate_outcome_invalid' })],
  ['D-A10: an incomplete review needs a retained relay result', "if (!relay) add('debate_outcome_invalid'", "if (!relay) void ('debate_outcome_invalid'",
    (t) => ({ x: incomplete(t, { roundOpts: { dispatch_error: { class: 'provider', text: 'spawn failed' } } }), code: 'debate_outcome_invalid' })],
  ['D-A10: CONVERGED is never an incomplete review', "if (att.incomplete_review === true) add('debate_outcome_invalid', 'CONVERGED", "if (false) add('debate_outcome_invalid', 'CONVERGED",
    (t) => ({ x: converged(t, { over: { incomplete_review: true } }), code: 'debate_outcome_invalid' })],
  ['D-A9: no comment spans a line', "if (lines[n].indexOf('-->', at + 4) < 0) return", 'if (false) return',
    (t) => { const base = withResult(narrative(), 'CONVERGED'); const line = base.split('\n').find((l) => l.startsWith('debate-dispositions-v1: ')); return { x: converged(t, { narr: base.replace(line, `<!--\n${line}\n-->`) }), code: 'debate_narrative_hidden_markup' }; }],
  ['dispositions debate_id binding', "if (D && D.debate_id !== att.debate_id) add('debate_attestation_invalid'", "if (false) add('debate_attestation_invalid'",
    (t) => ({ x: converged(t, { narr: narrative({ attestationRef: 'Attestation: debate-T-1-20261122T0900Z' }) }), code: 'debate_attestation_invalid' })],
  ['dispositions carrier_degraded binding', "if (D && D.carrier_degraded !== carrier.degraded) add('debate_carrier_invalid'", "if (false) add('debate_carrier_invalid'",
    (t) => ({ x: converged(t, { over: { carrier: { agent: 'fable', kind: 'native_session', identity: 'claude:fable', degraded: true } }, r1: { kind: 'native_session', session: 'f1' }, r2: { kind: 'native_session', session: 'f1' } }), code: 'debate_carrier_invalid' })],
  ['round verdict equals the response object', "if (parsed.obj.verdict !== r.verdict) add('debate_attestation_invalid'", "if (false) add('debate_attestation_invalid'",
    (t) => ({ x: converged(t, { r1: { verdict: 'AGREE', message: respond({ verdict: 'CHANGES_REQUESTED', request_id: 'req-1', plan_version: 'v1', plan_digest: OLD_DIGEST, findings: [{ id: 'P1', status: 'new', severity: 'major' }] }) } }), code: 'debate_attestation_invalid' })],
  ['brief plan_digest binding', 'if (b.request_id !== r.request_id || b.plan_version !== r.plan_version || b.plan_digest !== r.plan_digest) {', 'if (b.request_id !== r.request_id || b.plan_version !== r.plan_version) {',
    (t) => ({ x: converged(t, { r2: { brief: `request_id: req-final\nplan_version: v2\nplan_digest: sha256:${'9'.repeat(64)}\n` } }), code: 'debate_request_mismatch' })],
  ['derivation: the highest severity wins', 'Math.max(cur?.rank ?? 0, f.severity ? RANK[f.severity] : (cur ? 0 : 4))', '(f.severity ? RANK[f.severity] : (cur ? cur.rank : 4))',
    (t) => ({ x: unresolved(t, { r1: { findings: [{ id: 'P3', status: 'new', severity: 'blocker' }] }, r2: { findings: [{ id: 'P3', status: 'maintained', severity: 'minor' }] }, findings: [FIND({ id: 'P3', severity: 'minor', status: 'open', closed_by: undefined, closed_round: undefined, evidence: undefined, host_position: 'h', counterpart_position: 'c' })] }), code: 'debate_attestation_invalid' })],
  ['derivation: a never-opened maintained id has unknown severity', ': (cur ? 0 : 4));', ': (cur ? 0 : 1));',
    (t) => ({ x: unresolved(t, { r2: { findings: [{ id: 'P3', status: 'maintained' }, { id: 'P5', status: 'maintained' }] }, findings: [FIND({ id: 'P3', status: 'open', closed_by: undefined, closed_round: undefined, evidence: undefined, host_position: 'h', counterpart_position: 'c' }), FIND({ id: 'P5', severity: 'minor', status: 'open', closed_by: undefined, closed_round: undefined, evidence: undefined, host_position: 'h', counterpart_position: 'c' })] }), code: 'debate_attestation_invalid' })],
  ['dispositions top-level keys', 'if (!sameKeys(d, DISPO_KEYS)) return { error:', 'if (false) return { error:',
    (t) => ({ x: converged(t, { narr: withResult(narrative(), 'CONVERGED', { extra: 1 }) }), code: 'debate_attestation_invalid' })],
  ['dispositions exception shape', 'if (d.exception !== null && !(sameKeys(d.exception, EXCEPTION_KEYS)', 'if (d.exception !== null && false && !(sameKeys(d.exception, EXCEPTION_KEYS)',
    (t) => ({ x: converged(t, { narr: withResult(narrative(), 'CONVERGED', { exception: { kind: 'WAIVED', reason: 'r', scope: 'this ticket', ack: 'a', extra: 1 } }) }), code: 'debate_attestation_invalid' })],
  ['dispositions unique ids', 'if (ids.has(row.id)) return { error:', 'if (false) return { error:',
    (t) => ({ x: unresolved(t, { narr: narrative({ rows: [['P3', 'accept_risk', 'One.', 'no'], ['P3', 'decided', 'Two.', 'no']] }) }), code: 'debate_attestation_invalid' })],
  ['digest binding', 'if (final.plan_digest !== digest) add(\'debate_digest_mismatch\'', 'if (false) add(\'debate_digest_mismatch\'',
    (t) => { const x = converged(t); return { x, text: planText(narrative({ body: 'Edited.' }), [x.line]), code: 'debate_digest_mismatch' }; }],
  ['evidence hash', 'if (sha256Of(bytes) !== want) add(\'debate_evidence_mismatch\'', 'if (false) add(\'debate_evidence_mismatch\'',
    (t) => { const x = converged(t); writeFileSync(join(x.bundle, 'r2', 'events.jsonl'), 'x'); return { x, code: 'debate_evidence_mismatch' }; }],
  ['response request_id binding', 'if (o.request_id !== expect.request_id) return bad(', 'if (false) return bad(',
    (t) => ({ x: converged(t, { r2: { echo_request_id: 'req-1' } }), code: 'debate_request_mismatch' })],
  ['response canonical bytes (the key-tracking guard)', 'if (JSON.stringify(ordered) !== text) return bad(', 'if (false) return bad(',
    (t) => { const D = digestOf(withResult(narrative(), 'CONVERGED')); return { x: converged(t, { r2: { message: JSON.stringify(JSON.parse(respond({ request_id: 'req-final', plan_version: 'v2', plan_digest: D, findings: [{ id: 'P1', status: 'confirmed' }] })), null, 1) } }), code: 'debate_response_invalid' }; }],
  ['read-only sandbox', "if (res.sandbox !== 'read-only')", 'if (false)',
    (t) => ({ x: converged(t, { r2: { sandbox: 'workspace-write' } }), code: 'debate_carrier_invalid' })],
  ['workdir', 'if (resolve(String(res.workdir)) !== resolve(String(att.workdir)))', 'if (false)',
    (t) => ({ x: converged(t, { r2: { workdir: resolve(tmpdir(), 'elsewhere') } }), code: 'debate_carrier_invalid' })],
  ['open blocker in the derived ledger', "if (open.some(([, d]) => d.rank >= RANK.major)) add('debate_open_finding'", "if (false) add('debate_open_finding'",
    (t) => ({ x: converged(t, { r1: { findings: [{ id: 'P1', status: 'new', severity: 'major' }, { id: 'P9', status: 'new', severity: 'blocker' }] }, over: { findings: [FIND(), FIND({ id: 'P9', severity: 'blocker', status: 'open', closed_by: undefined, closed_round: undefined, evidence: undefined, host_position: 'h', counterpart_position: 'c' })] } }), code: 'debate_open_finding' })],
  ['limit never converged', "if (att.final !== null) add('debate_outcome_invalid', 'LIMIT_REACHED", "if (false) add('debate_outcome_invalid', 'LIMIT_REACHED",
    (t) => ({ x: limited(t, { over: { final: { request_id: 'req-1', plan_version: 'v1', plan_digest: 'sha256:x', verdict: 'AGREE' } } }), code: 'debate_outcome_invalid' })],
  ['skip exception', "if (!exceptionOk(D, 'SKIPPED')) add('debate_exception_missing'", "if (false) add('debate_exception_missing'",
    (t) => ({ x: skipped(t, { carrier: {} }), code: 'debate_exception_missing' })],
  ['degradation acknowledgement', "if (att.carrier.degraded && !(D?.carrier_degraded === true && D.degradation_ack === DEGRADED_ACK)) add('debate_degradation_unacknowledged'", "if (false) add('debate_degradation_unacknowledged'",
    (t) => ({ x: converged(t, { over: { carrier: { agent: 'codex', kind: 'codex_relay', identity: 'codex:gpt-5.5', degraded: true } } }), code: 'debate_degradation_unacknowledged' })],
  ['replayed request_id', "if (seen.has(r.request_id)) add('debate_request_mismatch'", "if (false) add('debate_request_mismatch'",
    (t) => ({ x: converged(t, { r1: { request_id: 'req-final' } }), code: 'debate_request_mismatch' })],
  ['carrier pairing', "if (!carrier.degraded && (carrier.agent !== PAIRED[host.agent] || base.diversity === 'same_provider')) {", 'if (false) {',
    (t) => ({ x: converged(t, { over: { carrier: { agent: 'claude', kind: 'claude_relay', identity: 'claude:opus-5-5', degraded: false } }, r1: { kind: 'claude_relay', session: 's' }, r2: { kind: 'claude_relay', session: 's' } }), code: 'debate_carrier_invalid' })],
  ['Claude subscription auth', "if (r.auth_method !== 'claude.ai') add('debate_carrier_invalid'", "if (false) add('debate_carrier_invalid'",
    (t) => ({ x: converged(t, { over: { host: { agent: 'codex', identity: 'codex:gpt-5.5' }, carrier: { agent: 'claude', kind: 'claude_relay', identity: 'claude:opus-5-5', degraded: false } }, r1: { kind: 'claude_relay', session: 's' }, r2: { kind: 'claude_relay', session: 's', auth_method: 'api_key' } }), code: 'debate_carrier_invalid' })],
  ['configured budget reached', "else if (!configured.some(([v, u]) => typeof u === 'number' && u >= v && L.evidence.includes(String(v)))) add('debate_limit_invalid'", "else if (false) add('debate_limit_invalid'",
    (t) => ({ x: limited(t, { roundOpts: { status: 'completed' }, over: { budget: { max_rounds: 5, max_minutes: null }, limit: { kind: 'configured_budget', evidence: 'max_rounds: 5' } } }), code: 'debate_limit_invalid' })],
  ['empty findings need incomplete_review', "if (!ledger.size && att.incomplete_review !== true) add('debate_limit_invalid'", "if (false) add('debate_limit_invalid'",
    (t) => ({ x: limited(t, { over: { rounds: [], findings: [], incomplete_review: false, budget: { max_rounds: null, max_minutes: 1 }, metrics: { rounds: 0, calls: 0, minutes: 1, started_at: null, ended_at: null, tokens: null }, limit: { kind: 'configured_budget', evidence: 'max_minutes: 1' } } }), code: 'debate_limit_invalid' })],
  ['UNRESOLVED needs an outstanding finding', "if (!open.length || open.some(([id]) => !nonEmpty(attById.get(id)?.host_position) || !nonEmpty(attById.get(id)?.counterpart_position))) add('debate_outcome_invalid'", "if (false) add('debate_outcome_invalid'",
    (t) => ({ x: unresolved(t, { r2: { verdict: 'AGREE', findings: [{ id: 'P3', status: 'confirmed' }] }, findings: [FIND({ id: 'P3', closed_round: 2 })] }), code: 'debate_outcome_invalid' })],
  ['canonical attestation bytes', 'if (again !== line) return bad(', 'if (false) return bad(',
    (t) => { const x = converged(t); return { x, text: planText(x.narr, [x.line.replace('{"', '{ "')]), code: 'debate_attestation_invalid' }; }],
  ['workdir is the repository or a registered worktree', 'if (realOr(wd) !== realOr(top) && !registered(top, wd)) unbound(', 'if (false) unbound(',
    (t) => { const o = gitRepo('debate-other-'); t.after(() => rmSync(o, { recursive: true, force: true })); return { x: converged(t, { over: { workdir: o }, r1: { workdir: o }, r2: { workdir: o } }), code: 'debate_workdir_unbound' }; }],
  ['registered worktree, not any gitdir pointing at the repository', "realOr(l.slice('worktree '.length)) === realOr(wd))", "true)",
    (t) => { const wd = tmp(t, 'debate-fakewt-'); const fake = tmp(t, 'debate-fakegit-'); writeFileSync(join(fake, 'HEAD'), 'ref: refs/heads/main\n'); writeFileSync(join(fake, 'commondir'), `${join(REPO, '.git')}\n`); writeFileSync(join(fake, 'gitdir'), `${join(wd, '.git')}\n`); writeFileSync(join(wd, '.git'), `gitdir: ${fake}\n`);
      return { x: converged(t, { over: { workdir: wd }, r1: { workdir: wd }, r2: { workdir: wd } }), code: 'debate_workdir_unbound' }; }],
  ['snapshot workdir kind refused', "if (att.workdir_kind !== undefined && att.workdir_kind !== 'repo') { unbound(", 'if (false) { unbound(',
    (t) => ({ x: converged(t, { over: { workdir_kind: 'snapshot', snapshot: { base: headOf(REPO), entries: lsTree(REPO) } } }), code: 'debate_workdir_unbound' })],
  ['closing an id that is not open', "if (!cur?.open) { add('debate_response_invalid'", "if (!cur?.open) { continue; add('debate_response_invalid'",
    (t) => ({ x: converged(t, { r2: { concede: ['P1', 'P9'] } }), code: 'debate_response_invalid' })],
  ['AGREE contradiction', "if (o.verdict === 'AGREE' && o.findings.some(", "if (false && o.findings.some(",
    (t) => ({ x: converged(t, { r1: { findings: [{ id: 'P1', status: 'new', severity: 'major' }, { id: 'P9', status: 'new', severity: 'minor' }] }, r2: { findings: [{ id: 'P1', status: 'confirmed' }, { id: 'P9', status: 'maintained' }] },
      over: { findings: [FIND(), FIND({ id: 'P9', severity: 'minor', status: 'open', closed_by: undefined, closed_round: undefined, evidence: undefined, host_position: 'h', counterpart_position: 'c' })] } }), code: 'debate_response_invalid' })],
  ['CHANGES_REQUESTED contradiction', "if (o.verdict === 'CHANGES_REQUESTED' && !o.findings.some(", "if (false && !o.findings.some(",
    (t) => ({ x: unresolved(t, { r2: { findings: [] } }), code: 'debate_response_invalid' })],
  ['exactly one dispositions line', 'if (count !== 1) return { error:', 'if (false) return { error:',
    (t) => { const base = withResult(narrative(), 'CONVERGED'); const line = base.split('\n').find((l) => l.startsWith('debate-dispositions-v1: ')); return { x: converged(t, { narr: base.replace('## 8.', `${line}\n\n## 8.`) }), code: 'debate_attestation_invalid' }; }],
  ['dispositions line canonical bytes', 'if (serializeDispositions(d) !== line) return { error:', 'if (false) return { error:',
    (t) => { const base = withResult(narrative(), 'CONVERGED'); const line = base.split('\n').find((l) => l.startsWith('debate-dispositions-v1: '));
      const loose = 'debate-dispositions-v1: ' + JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(line.slice(24))).reverse())); return { x: converged(t, { narr: base.replace(line, loose) }), code: 'debate_attestation_invalid' }; }],
  ['disposition kinds are concrete (a pending finding has no row)', "if (!sameKeys(row, DISPOSITION_KEYS) || typeof row.id !== 'string' || !CONCRETE.has(row.kind)", "if (!sameKeys(row, DISPOSITION_KEYS) || typeof row.id !== 'string' || false",
    (t) => ({ x: unresolved(t, { narr: narrative({ rows: [['P3', 'decide', 'later', 'no']] }) }), code: 'debate_attestation_invalid' })],
  ['completed round exit code 0', "if (r.status === 'completed' && (r.exit_code !== 0 || res.exitCode !== 0)) add('debate_evidence_mismatch'", "if (false) add('debate_evidence_mismatch'",
    (t) => ({ x: converged(t, { r2: { exit_code: 7 } }), code: 'debate_evidence_mismatch' })],
  ['completed round session id', "if (r.status === 'completed' && !nonEmpty(r.session_id)) add('debate_carrier_invalid'", "if (false) add('debate_carrier_invalid'",
    (t) => ({ x: converged(t, { r2: { omitIds: true } }), code: 'debate_carrier_invalid' })],
  ['every round read-only', "if (r.read_only !== true) add('debate_carrier_invalid'", "if (false) add('debate_carrier_invalid'",
    (t) => ({ x: converged(t, { over: { host: { agent: 'codex', identity: 'codex:gpt-5.5' }, carrier: { agent: 'claude', kind: 'native_session', identity: 'claude:opus-5-5', degraded: false } }, r1: { kind: 'native_session', session: 's1' }, r2: { kind: 'native_session', session: 's1', read_only: false } }), code: 'debate_carrier_invalid' })],
  ['attestation ledger equals the derived ledger', "if (!same) add('debate_attestation_invalid', `the attestation ledger entry", "if (false) add('debate_attestation_invalid', `the attestation ledger entry",
    (t) => ({ x: converged(t, { r2: { concede: [] } }), code: 'debate_attestation_invalid' })],
  ['no finding only the attestation names', "for (const id of attById.keys()) if (!ledger.has(id)) add('debate_attestation_invalid'", "for (const id of attById.keys()) if (false) add('debate_attestation_invalid'",
    (t) => ({ x: converged(t, { over: { findings: [FIND(), FIND({ id: 'P7', severity: 'minor', status: 'open', closed_by: undefined, closed_round: undefined, evidence: undefined, host_position: 'h', counterpart_position: 'c' })] } }), code: 'debate_attestation_invalid' })],
  ['no symlink inside a bundle', "if (lstatSync(p).isSymbolicLink()) return { code: 'debate_evidence_mismatch'", "if (false) return { code: 'debate_evidence_mismatch'",
    (t) => { const x = converged(t); spawnSync('mv', [join(x.bundle, 'r2'), join(x.bundle, 'r2real')]); symlinkSync('r2real', join(x.bundle, 'r2')); return { x, code: 'debate_evidence_mismatch' }; }],
  ['dispositions-line outcome matches the attestation', "if (D && D.outcome !== outcome) add('debate_outcome_invalid'", "if (false) add('debate_outcome_invalid'",
    (t) => ({ x: converged(t, { narr: withResult(narrative(), 'UNRESOLVED') }), code: 'debate_outcome_invalid' })],
  ['{-leading attestation refused', "if (R.events.some((e) => Object.hasOwn(e, 'debate-attestation-v1') || Object.hasOwn(e, 'debate_id'))) {", 'if (false) {',
    (t) => { const x = converged(t); return { x, text: planText(x.narr, [JSON.stringify({ debate_id: DEBATE_ID, outcome: 'CONVERGED' })]), code: 'debate_attestation_invalid' }; }],
];
const PROBE_OK = { relay_present: true, codex_version: { status: 0, version: 'codex-cli 1.0.0', path: '/x/codex' }, login: { status: 0 }, nonce: 'n',
  dispatch: { result: { status: 'completed', threadId: 't', sandbox: 'read-only', codexVersion: 'codex-cli 1.0.0', finalMessage: PROBE_MSG('n') } },
  resume: { result: { status: 'completed', threadId: 't', sandbox: 'read-only' } }, cancel: { child_seen: true, result: { status: 'timeout' }, survivors: [] }, coverage: { before: 'c', after: 'c', ignored_before: 'i', ignored_after: 'i' } };
const OTHER_MUTANTS = [
  ['D-A10: untrusted JSON depth is checked iteratively before serializing', 'if (d > MAX_JSON_DEPTH) return true;', 'if (false) return true;',
    (mod, t) => { const base = withResult(narrative(), 'CONVERGED'); const line = base.split('\n').find((l) => l.startsWith('debate-dispositions-v1: '));
      const deep = `debate-dispositions-v1: ${JSON.stringify({ ...JSON.parse(line.slice(24)), dispositions: [{ id: 'P1', kind: 'accept_risk', resolution: DEEP(5000, 'x'), design_change: false }] })}`;
      const x = converged(t, { narr: base.replace(line, deep) });
      try { return codes(mod.debateCheck(x.text, { bundleDir: x.bundle, repo: REPO })).includes('debate_attestation_invalid'); } catch { return false; } }],
  ['probe: fresh_result needs an explicit AGREE', "probeExpect(o.nonce)).obj?.verdict === 'AGREE' ?", 'probeExpect(o.nonce)).ok ?',
    (mod) => mod.classifyProbe({ relay_present: true, codex_version: { status: 0 }, login: { status: 0 }, nonce: 'n1', dispatch: { result: { status: 'completed', threadId: 'th-1', sandbox: 'read-only',
      finalMessage: JSON.stringify({ v: 1, request_id: 'probe-n1', plan_version: 'v1', plan_digest: `sha256:${'0'.repeat(64)}`, verdict: 'CHANGES_REQUESTED', findings: [{ id: 'P1', status: 'new', severity: 'major' }] }) } } }).fresh_result.result === 'fail'],
  ...[
    ['response: v is 1', 'if (o.v !== 1) return bad(', (o) => ({ ...o, v: 2 })],
    ['response: request_id format', "if (typeof o.request_id !== 'string' || !SAFE_SEGMENT.test(o.request_id)) return bad(", (o) => ({ ...o, request_id: '../x' })],
    ['response: plan_version format', "if (typeof o.plan_version !== 'string' || !PLAN_VERSION.test(o.plan_version)) return bad(", (o) => ({ ...o, plan_version: 'version1' })],
    ['response: plan_digest format', "if (typeof o.plan_digest !== 'string' || !DIGEST_FORMAT.test(o.plan_digest)) return bad(", (o) => ({ ...o, plan_digest: 'sha256:abc' })],
    ['response: verdict enum', "if (o.verdict !== 'AGREE' && o.verdict !== 'CHANGES_REQUESTED') return bad(", (o) => ({ ...o, verdict: 'MAYBE' })],
    ['response: at most 12 findings', 'if (!Array.isArray(o.findings) || o.findings.length > 12) return bad(', (o) => ({ ...o, findings: Array.from({ length: 13 }, (_, i) => ({ id: `P${i + 1}`, status: 'new', severity: 'minor' })) })],
    ['response: finding id format', "if (typeof f.id !== 'string' || !FINDING_ID.test(f.id)) return bad(", (o) => ({ ...o, findings: [{ id: 'P 1', status: 'new', severity: 'major' }] })],
    ['response: unique finding ids', 'if (ids.has(f.id)) return bad(', (o) => ({ ...o, findings: [{ id: 'P1', status: 'new', severity: 'major' }, { id: 'P1', status: 'new', severity: 'minor' }] })],
    ['response: status enum', 'if (!RESPONSE_STATUS.includes(f.status)) return bad(', (o) => ({ ...o, findings: [{ id: 'P1', status: 'new', severity: 'major' }, { id: 'P2', status: 'pending', severity: 'major' }] })],
    ['response: severity required for new', "if (Object.hasOwn(f, 'severity') ? !SEVERITIES.includes(f.severity) : f.status === 'new') return bad(", (o) => ({ ...o, findings: [{ id: 'P1', status: 'new' }] })],
    ['response: note length', "if (Object.hasOwn(f, 'note') && !(typeof f.note === 'string' && f.note.length <= 2000)) return bad(", (o) => ({ ...o, findings: [{ id: 'P1', status: 'new', severity: 'major', note: 'n'.repeat(2001) }] })],
    ['response: plan_digest binding', 'if (o.plan_digest !== expect.plan_digest) return bad(', (o) => ({ ...o, plan_digest: `sha256:${'2'.repeat(64)}` })],
    ['response: plan_version binding', 'if (o.plan_version !== expect.plan_version) return bad(', (o) => ({ ...o, plan_version: 'v2' })],
  ].map(([name, find, change]) => [name, find, find.replace(/^(\s*)if \(/, '$1if (false) if ('),
    (mod) => !mod.parseResponse(JSON.stringify(change(JSON.parse(resp()))), name.includes('binding') ? EXPECT : null).ok]),
  ['response: size limit', 'if (Buffer.byteLength(text, \'utf8\') > RESPONSE_MAX_BYTES) return bad(', 'if (false) return bad(',
    (mod) => !mod.parseResponse(resp({ findings: Array.from({ length: 12 }, (_, i) => ({ id: `P${i + 1}`, status: 'new', severity: 'minor', note: 'n'.repeat(1990) })) }), EXPECT).ok],
  ['response: strict UTF-8 bytes', "try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }", "try { text = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(bytes); }",
    (mod) => { const base = resp({ findings: [{ id: 'P1', status: 'new', severity: 'major', note: 'ab' }] }); const at = base.indexOf('"ab"') + 2;
      return !mod.parseResponseBytes(Buffer.concat([Buffer.from(base.slice(0, at)), Buffer.from([0xff]), Buffer.from(base.slice(at))]), null).ok; }],
  ['git overrides scrubbed', "const gitEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));", 'const gitEnv = () => process.env;',
    (mod, t) => {
      const plain = tmp(t, 'debate-plain-');
      const x = converged(t, { over: { workdir: plain }, r1: { workdir: plain }, r2: { workdir: plain } });
      const saved = [process.env.GIT_DIR, process.env.GIT_WORK_TREE];
      process.env.GIT_DIR = join(REPO, '.git');
      process.env.GIT_WORK_TREE = plain;
      try { return codes(mod.debateCheck(x.text, { bundleDir: x.bundle, repo: REPO })).includes('debate_workdir_unbound'); } finally {
        if (saved[0] === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved[0];
        if (saved[1] === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = saved[1];
      }
    }],
  ['probe: an empty CLI version fails closed', "else if (cli && Object.hasOwn(cli, 'version') && !nonEmpty(cli.version)) dispatch = no('provider'", "else if (false) dispatch = no('provider'",
    (mod) => mod.classifyProbe({ ...PROBE_OK, codex_version: { status: 0, version: '', path: '/usr/bin/true' }, dispatch: { result: { ...PROBE_OK.dispatch.result, codexVersion: '' } } }).dispatch.result === 'fail'],
  ['probe: the relay runs the probed CLI', 'else if (nonEmpty(cli?.version) && String(', 'else if (false && String(',
    (mod) => mod.classifyProbe({ ...PROBE_OK, dispatch: { result: { ...PROBE_OK.dispatch.result, codexVersion: 'codex-cli 9.9.9' } } }).dispatch.result === 'fail'],
  ['probe: the resumed session stays read-only', ": !readOnly(rs.result) ? no('relay', 'the resumed session is not read-only')", ": false ? no('relay', 'the resumed session is not read-only')",
    (mod) => mod.classifyProbe({ ...PROBE_OK, resume: { result: { status: 'completed', threadId: 't', sandbox: 'workspace-write' } } }).resume.result === 'fail'],
  ['probe: failed process listing', ": c.listing_failed ? no('relay'", ": false ? no('relay'",
    (mod) => mod.classifyProbe({ relay_present: true, codex_version: { status: 0 }, login: { status: 0 }, nonce: 'n', dispatch: { result: { status: 'completed', threadId: 't', sandbox: 'read-only', finalMessage: PROBE_MSG('n') } },
      resume: { result: { status: 'completed', threadId: 't' } }, cancel: { child_seen: true, listing_failed: true, result: { status: 'timeout' }, survivors: [] }, coverage: {} }).cancellation.result === 'fail'],
  ['probe: Claude subscription auth', "else if (claude && o.login.authMethod !== 'claude.ai') dispatch = no('auth'", "else if (false) dispatch = no('auth'",
    (mod) => mod.classifyProbe({ carrier: 'claude', relay_present: true, cli_version: { status: 0 }, login: { status: 0, authMethod: 'api_key' }, nonce: 'n', dispatch: { result: { status: 'completed', sessionId: 's', readOnly: true, finalMessage: PROBE_MSG('n') } } }).dispatch.result === 'fail'],
  ['retain: symlinked destination component', "if (st && (st.isSymbolicLink() || !st.isDirectory())) return refuse('debate_evidence_mismatch'", "if (false) return refuse('debate_evidence_mismatch'",
    (mod, t) => {
      if (win) return true;
      const x = converged(t); const common = tmp(t, 'debate-common-'); const elsewhere = tmp(t, 'debate-elsewhere-');
      mkdirSync(join(common, 'ai-skills', 'ship-ticket', 'debate'), { recursive: true });
      symlinkSync(elsewhere, join(common, 'ai-skills', 'ship-ticket', 'debate', TICKET));
      const r = mod.retainBundle(x.text, { from: x.bundle, to: B.debateLocator(common, TICKET, DEBATE_ID), root: common, repo: REPO });
      return !r.ok && readdirSync(elsewhere).length === 0;
    }],
];
for (const [name, find, replace, refuses] of OTHER_MUTANTS) {
  test(`mutation: ${name} — the mutant accepts the defect, the real code refuses it`, { skip: name.startsWith('retain') && POSIX_ONLY }, async (t) => {
    const m = await mutant(find, replace);
    assert.equal(refuses(B, t), true, 'the real code refuses');
    assert.equal(refuses(m, t), false, 'the mutant lets it through');
  });
}
for (const [name, find, replace, make] of MUTANTS) {
  test(`mutation: ${name} — the mutant accepts the defect, the real checker refuses it`, async (t) => {
    const m = await mutant(find, replace);
    const { x, text = x.text, code } = make(t);
    assert.ok(codes(B.debateCheck(text, { bundleDir: x.bundle, repo: REPO })).includes(code), `real checker refuses with ${code}`);
    assert.ok(!codes(m.debateCheck(text, { bundleDir: x.bundle, repo: REPO })).includes(code), `mutant no longer refuses with ${code}`);
  });
}
const START_MUTANTS = [
  ['D-A10: an incomplete review needs the LIMIT disposition', "const needsLimit = outcome === 'LIMIT_REACHED' || (outcome === 'UNRESOLVED' && att.incomplete_review === true);", "const needsLimit = outcome === 'LIMIT_REACHED';",
    (t) => ({ x: incomplete(t), code: 'debate_disposition_pending' })],
  ['waived needs the frozen exception', "if (row.kind === 'waived' && !exceptionOk(D, 'WAIVED') && !exceptionOk(D, 'SKIPPED')) return ['debate_disposition_pending'", "if (false) return ['debate_disposition_pending'",
    (t) => ({ x: unresolved(t, { narr: narrative({ rows: [['P3', 'waived', 'Out of scope.', 'no']] }) }), code: 'debate_disposition_pending' })],
  ['pending disposition', "if (placeholder(row.resolution)) return ['debate_disposition_pending'", "if (false) return ['debate_disposition_pending'",
    (t) => { const x = unresolved(t, { narr: narrative({ rows: [['P3', 'accept_risk', '', 'no']] }) }); return { x, code: 'debate_disposition_pending' }; }],
  ['attestation hash at START', "if (start.debate_attestation_sha256 !== got.sha256) add('debate_attestation_changed'", "if (false) add('debate_attestation_changed'",
    (t) => { const x = converged(t); const changed = B.serializeAttestation({ ...x.att, metrics: { ...x.att.metrics, minutes: 99 } }); return { x, lines: [changed], code: 'debate_attestation_changed' }; }],
  ['policy applicability', "if (!debateLegacyApproval(start)) add('debate_policy_missing'", "if (false) add('debate_policy_missing'",
    (t) => { const narr = narrative({ policy: null }); return { x: { narr, D: digestOf(narr), line: null, att: null }, noStartHash: true, code: 'debate_policy_missing' }; }],
  ['design change needs reconfirmation', "if (row.design_change && !reconfirmed(rounds, digest)) return ['debate_reconfirm_required'", "if (false) return ['debate_reconfirm_required'",
    (t) => ({ x: unresolved(t, { narr: narrative({ rows: [['P3', 'decided', 'Adopt B.', 'yes']] }) }), code: 'debate_reconfirm_required' })],
  ['locator ancestors are real directories', "if (c.isSymbolicLink() || !c.isDirectory()) return { code: 'debate_evidence_mismatch', why: `${p} is a symbolic link or not a directory; the retained locator", "if (false) return { code: 'debate_evidence_mismatch', why: `${p} is a symbolic link or not a directory; the retained locator",
    (t) => ({ x: converged(t), code: 'debate_evidence_mismatch', ancestorLink: true })],
  ['reconfirmation under a version no older digest used', 'every((r) => r.plan_version !== lc.plan_version', 'every((r) => true || r.plan_version !== lc.plan_version',
    (t) => { const narr = withResult(narrative({ rows: [['P3', 'decided', 'Adopt B.', 'yes']] }), 'UNRESOLVED'); const D = digestOf(narr);
      return { x: unresolved(t, { narr, r2: { plan_version: 'v1', plan_digest: 'sha256:' + 'c'.repeat(64), verdict: 'CHANGES_REQUESTED' }, r3: { plan_version: 'v1', plan_digest: D, verdict: 'AGREE', request_id: 'req-3' } }), code: 'debate_reconfirm_required' }; }],
  ['reconfirmation version is numerically newer', 'num(lc.plan_version) > num(r.plan_version)', 'true',
    (t) => { const narr = withResult(narrative({ rows: [['P3', 'decided', 'Adopt B.', 'yes']] }), 'UNRESOLVED'); const D = digestOf(narr);
      return { x: unresolved(t, { narr, r2: { plan_version: 'v3', plan_digest: 'sha256:' + 'c'.repeat(64), verdict: 'CHANGES_REQUESTED' }, r3: { plan_version: 'v2', plan_digest: D, verdict: 'AGREE', request_id: 'req-3' } }), code: 'debate_reconfirm_required' }; }],
  ['START needs the attestation hash', "if (!nonEmpty(start.debate_attestation_sha256)) { put('debate_attestation_missing'", "if (false) { put('debate_attestation_missing'",
    (t) => { const x = converged(t); return { x, startOver: { debate_attestation_sha256: undefined }, code: 'debate_attestation_missing' }; }],
];
for (const [name, find, replace, make] of START_MUTANTS) {
  test(`mutation (START): ${name} — the mutant accepts the defect, the real start-check refuses it`, async (t) => {
    const m = await mutant(find, replace);
    const { x, lines, code, noStartHash, startOver, ancestorLink } = make(t);
    if (ancestorLink && win) return;
    const dir = x.att ? retain(t, x) : null;
    if (ancestorLink) {
      const ticketDir = dirname(dir);
      const elsewhere = join(tmp(t, 'debate-elsewhere-'), TICKET);
      assert.equal(spawnSync('cp', ['-R', ticketDir, elsewhere]).status, 0);
      rmSync(ticketDir, { recursive: true, force: true });
      symlinkSync(elsewhere, ticketDir);
    }
    const s = noStartHash ? JSON.stringify({ run_id: 'r1', event: 'START', approved_plan_digest: x.D, approved_at: AFTER, approved_by: 'o' }) : startLine(x, startOver);
    const text = planText(x.narr, [...(lines ?? (x.line ? [x.line] : [])), s]);
    assert.ok(codes(B.startCheck(text, { runId: 'r1', now: NOW, bundleDir: dir, repo: REPO })).includes(code));
    assert.ok(!codes(m.startCheck(text, { runId: 'r1', now: NOW, bundleDir: dir, repo: REPO })).includes(code));
  });
}

// ================================================================== review repair 1 (PR #105): RED on each failing input first
const lsTree = (dir) => Object.fromEntries(spawnSync('git', ['-C', dir, 'ls-tree', 'HEAD'], { encoding: 'utf8' }).stdout.trim().split('\n').map((l) => { const [meta, name] = l.split('\t'); return [name, meta.split(' ')[2]]; }));
const headOf = (dir) => spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
test('[rr1-1] the relay workdir is bound to the repository: an unrelated directory named by both the result and the attestation is refused', (t) => {
  const other = tmp(t, 'unrelated-');
  const x = converged(t, { over: { workdir: other }, r1: { workdir: other }, r2: { workdir: other } });
  assert.ok(codes(pre(x)).includes('debate_workdir_unbound'), JSON.stringify(pre(x).errors));
  const common = tmp(t, 'debate-common-');
  assert.equal(B.retainBundle(x.text, { from: x.bundle, to: B.debateLocator(common, TICKET, DEBATE_ID), root: common, repo: REPO }).ok, false, 'debate-retain refuses it');
  const z = converged(t);
  assert.ok(codes(B.debateCheck(z.text, { bundleDir: z.bundle })).includes('debate_workdir_unbound'), 'without --repo the workdir is unbound, never assumed');
});

test('[rr2-R1] the binding is the repository itself or a linked worktree of it; a snapshot, a missing or a non-git workdir is refused', (t) => {
  const wt = join(tmp(t, 'debate-wt-parent-'), 'wt');
  assert.equal(spawnSync('git', ['-C', REPO, 'worktree', 'add', '-q', '--detach', wt, 'HEAD']).status, 0);
  t.after(() => spawnSync('git', ['-C', REPO, 'worktree', 'remove', '--force', wt]));
  const real = realpathSync(wt);
  assert.deepEqual(pre(converged(t, { over: { workdir: real }, r1: { workdir: real }, r2: { workdir: real } })).errors, [], 'a linked worktree of the same repository');
  const gone = join(tmp(t, 'debate-gone-'), 'missing');
  const entries = lsTree(REPO);
  const snap = converged(t, { over: { workdir: gone, workdir_kind: 'snapshot', snapshot: { base: headOf(REPO), entries } }, r1: { workdir: gone }, r2: { workdir: gone } });
  assert.ok(codes(pre(snap)).includes('debate_workdir_unbound'), 'a snapshot directory that does not exist, entries copied from git ls-tree');
  assert.ok(codes(pre(converged(t, { over: { workdir: gone }, r1: { workdir: gone }, r2: { workdir: gone } }))).includes('debate_workdir_unbound'), 'a missing workdir');
  const other = gitRepo('debate-other-');
  t.after(() => rmSync(other, { recursive: true, force: true }));
  assert.ok(codes(pre(converged(t, { over: { workdir: other }, r1: { workdir: other }, r2: { workdir: other } }))).includes('debate_workdir_unbound'), 'another repository with identical content');
  const sub = join(REPO, 'skills');
  assert.ok(codes(pre(converged(t, { over: { workdir: sub }, r1: { workdir: sub }, r2: { workdir: sub } }))).includes('debate_workdir_unbound'), 'a subdirectory is not the work tree top level');
});

test('[rr1-2] design_change is a boolean in the dispositions line; true needs a NEW plan_version and an AGREE for the current digest', (t) => {
  const go = (rows, r2) => {
    const narr = withResult(narrative({ rows }), 'UNRESOLVED');
    const D = digestOf(narr);
    const x = unresolved(t, { narr, r2: typeof r2 === 'function' ? r2(D) : r2 });
    return codes(sc(planText(x.narr, [x.line, startLine(x)]), retain(t, x)));
  };
  for (const cell of ['yes, adds field Y', 'maybe']) assert.ok(codes(pre(unresolved(t, { narr: narrative({ rows: [['P3', 'decided', 'add field Y', cell]] }) }))).includes('debate_attestation_invalid'), `a non-boolean design_change (${cell}) fails closed`);
  assert.deepEqual(go([['P3', 'decided', 'Adopt B.', 'yes']], (D) => ({ plan_version: 'v1', plan_digest: D, verdict: 'CHANGES_REQUESTED' })), ['debate_reconfirm_required'], 'same version, no AGREE');
  assert.deepEqual(go([['P3', 'decided', 'Adopt B.', 'yes']], (D) => ({ plan_version: 'v1', plan_digest: D, verdict: 'AGREE' })), ['debate_reconfirm_required'], 'AGREE but not a new plan_version');
  assert.deepEqual(go([['P3', 'decided', 'Adopt B.', 'yes']], (D) => ({ plan_version: 'v3', plan_digest: D, verdict: 'AGREE' })), [], 'new version, AGREE for the current digest');
});

test('[rr1-3] a completed relay round needs exit code 0 and a non-empty bound session id', (t) => {
  const x7 = converged(t, { r2: { exit_code: 7 } });
  assert.ok(codes(pre(x7)).includes('debate_evidence_mismatch'), 'status completed with exit 7');
  const none = converged(t, { r2: { omitIds: true } });
  const c = codes(pre(none));
  assert.ok(c.includes('debate_evidence_mismatch') && c.includes('debate_carrier_invalid'), JSON.stringify(c));
});

test('[rr1-4] a native-session round must be read-only', (t) => {
  const over = { host: { agent: 'codex', identity: 'codex:gpt-5.5' }, carrier: { agent: 'claude', kind: 'native_session', identity: 'claude:opus-5-5', degraded: false } };
  const ok = converged(t, { over, r1: { kind: 'native_session', session: 's1' }, r2: { kind: 'native_session', session: 's1' } });
  assert.deepEqual(pre(ok).errors, []);
  const rw = converged(t, { over, r1: { kind: 'native_session', session: 's1' }, r2: { kind: 'native_session', session: 's1', read_only: false } });
  assert.ok(codes(pre(rw)).includes('debate_carrier_invalid'));
});

test('[rr1-5] closures come only from verified response objects: an owner closure under CONVERGED and a silent round are refused', (t) => {
  const owner = converged(t, { narr: narrative({ rows: [['P1', 'accept_risk', 'The owner accepts the residual for this ticket.', 'no']] }), r2: { concede: [] },
    over: { findings: [FIND({ closed_by: 'owner', closed_round: undefined, evidence: undefined })] } });
  assert.ok(codes(pre(owner)).includes('debate_attestation_invalid'), 'the attestation may not close what no response object closed');
  assert.ok(codes(pre(owner)).includes('debate_open_finding'), 'the derived ledger keeps P1 open');
  const silent = converged(t, { r2: { concede: [] } });
  assert.ok(codes(pre(silent)).includes('debate_attestation_invalid'), 'round 2 never confirmed P1');
});

test('[rr1-6] retained bundle containment: a symlink inside it, or a symlinked destination component, is refused', { skip: POSIX_ONLY }, (t) => {
  const x = converged(t);
  const dir = retain(t, x);
  rmSync(join(dir, 'r2'), { recursive: true, force: true });
  symlinkSync(join(x.bundle, 'r2'), join(dir, 'r2'));
  assert.ok(codes(sc(planText(x.narr, [x.line, startLine(x)]), dir)).includes('debate_evidence_mismatch'), 'r2 points back into scratch');
  const common = tmp(t, 'debate-common-');
  const elsewhere = tmp(t, 'debate-elsewhere-');
  mkdirSync(join(common, 'ai-skills', 'ship-ticket', 'debate'), { recursive: true });
  symlinkSync(elsewhere, join(common, 'ai-skills', 'ship-ticket', 'debate', TICKET));
  const y = converged(t);
  assert.equal(B.retainBundle(y.text, { from: y.bundle, to: B.debateLocator(common, TICKET, DEBATE_ID), root: common, repo: REPO }).ok, false);
  assert.deepEqual(readdirSync(elsewhere), [], 'nothing was written through the symlink');
});

test('[rr1-8] probe classifier is carrier-specific: a Claude relay uses sessionId, readOnly and subscription auth', () => {
  const obs = { carrier: 'claude', relay_present: true, cli_version: { status: 0 }, login: { status: 0, authMethod: 'claude.ai' }, nonce: 'n1',
    dispatch: { result: { status: 'completed', sessionId: 's-1', readOnly: true, finalMessage: PROBE_MSG('n1') } }, resume: { result: { status: 'completed', sessionId: 's-1', readOnly: true } },
    cancel: { child_seen: true, result: { status: 'timeout' }, survivors: [] }, coverage: { before: 'c', after: 'c', ignored_before: 'i', ignored_after: 'i' } };
  for (const [k, v] of Object.entries(B.classifyProbe(obs))) assert.equal(v.result, k === 'cancellation' ? 'not_applicable_for_carrier' : 'pass', k);
  assert.equal(B.classifyProbe({ ...obs, login: { status: 0, authMethod: 'api_key' } }).dispatch.class, 'auth');
  assert.equal(B.classifyProbe({ ...obs, dispatch: { result: { ...obs.dispatch.result, readOnly: false } } }).fresh_result.result, 'fail');
});

const FAKE_CLAUDE = (method) => `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.0.0 (Claude Code)"; exit 0; fi\nif [ "$1" = "auth" ]; then echo '{"loggedIn":true,"authMethod":"${method}"}'; exit 0; fi\nexit 2\n`;
test('[rr1-8] probe with a FAKE Claude relay (parser only): passes with subscription auth, auth class with an API key', { skip: POSIX_ONLY }, (t) => {
  for (const [method, want] of [['claude.ai', 'pass'], ['api_key', 'fail']]) {
    const f = probeFixture(t);
    writeFileSync(join(f.d, 'claude'), FAKE_CLAUDE(method));
    chmodSync(join(f.d, 'claude'), 0o755);
    const r = probe({ ...f, codex: join(f.d, 'claude') }, 'ok', ['--carrier', 'claude'], { FAKE_CARRIER: 'claude' });
    const out = JSON.parse(r.stdout);
    assert.equal(out.carrier, 'claude');
    assert.equal(out.codex_route.dispatch.result, want, JSON.stringify(out.codex_route));
    if (want === 'pass') for (const k of ['dispatch', 'fresh_result', 'resume', 'coverage']) assert.equal(out.codex_route[k].result, 'pass', JSON.stringify(out.codex_route));
  }
});

test('[rr1-9] a failed process listing is a cancellation failure, never a pass', { skip: POSIX_ONLY }, (t) => {
  assert.equal(B.classifyProbe({ relay_present: true, codex_version: { status: 0 }, login: { status: 0 }, nonce: 'n', dispatch: { result: { status: 'completed', threadId: 't', finalMessage: PROBE_MSG('n') } },
    resume: { result: { status: 'completed', threadId: 't' } }, cancel: { child_seen: true, listing_failed: true, result: { status: 'timeout' }, survivors: [] }, coverage: {} }).cancellation.class, 'relay');
  const f = probeFixture(t);
  const bin = join(f.d, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'ps'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(bin, 'ps'), 0o755);
  const out = JSON.parse(probe(f, 'ok', [], { PATH: `${bin}:${process.env.PATH}` }).stdout);
  assert.equal(out.codex_route.cancellation.result, 'fail', JSON.stringify(out.codex_route.cancellation));
});

test('[rr1-10] the degraded carrier is a transport label: the acknowledgement claims no more than the checker enforces, a Fable concession counts like any other', (t) => {
  assert.ok(B.DEGRADED_ACK.includes('does not by itself resolve or waive any finding'), B.DEGRADED_ACK);
  const over = { carrier: { agent: 'fable', kind: 'native_session', identity: 'claude:fable', degraded: true } };
  const x = converged(t, { narr: narrative({ carrier: { degraded: true, degradationAck: B.DEGRADED_ACK } }), over, r1: { kind: 'native_session', session: 'f1' }, r2: { kind: 'native_session', session: 'f1' } });
  assert.deepEqual(pre(x).errors, []);
  assert.equal(pre(x).debate_qualified, true, 'the same convergence checks apply to a degraded carrier');
});

test('[rr1-11] an interrupted probe forwards the signal: the relay and its child are gone afterwards', { skip: POSIX_ONLY }, async (t) => {
  const f = probeFixture(t);
  const c = spawn(process.execPath, [CLI, 'debate-probe', '--relay', f.relay, '--repo', f.repo, '--out-dir', f.out, '--cli', f.codex, '--busy-timeout', '60s'], { env: { ...process.env, FAKE_MODE: 'ok' }, stdio: 'ignore' });
  const pidFile = join(f.out, 'cancel', 'pids');
  const until = async (ok, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (ok()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
  assert.ok(await until(() => existsSync(pidFile), 30_000), 'the busy relay started');
  const [relayPid, childPid] = readFileSync(pidFile, 'utf8').trim().split(' ').map(Number);
  const closed = new Promise((r) => c.on('close', (code, sig) => r({ code, sig })));
  c.kill('SIGTERM');
  const res = await closed;
  assert.notEqual(res.code, 0, 'the interrupted probe does not report success');
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.ok(await until(() => !alive(relayPid) && !alive(childPid), 5_000), `relay ${relayPid} or child ${childPid} still running`);
});

test('[rr1-12] a fenced JSON response is refused; the dispositions-line outcome must match the attestation outcome', (t) => {
  const D = digestOf(withResult(narrative(), 'CONVERGED'));
  const fenced = '```json\n' + respond({ request_id: 'req-final', plan_version: 'v2', plan_digest: D, findings: [{ id: 'P1', status: 'confirmed' }] }) + '\n```';
  assert.ok(codes(pre(converged(t, { r2: { message: fenced } }))).includes('debate_response_invalid'));
  const mismatch = converged(t, { narr: withResult(narrative(), 'UNRESOLVED'), over: {} });
  assert.ok(codes(pre(mismatch)).includes('debate_outcome_invalid'), 'outcome UNRESOLVED in the line over a CONVERGED attestation');
});

// ================================================================== review repair 2 (PR #105 at e962a37): root causes
test('[rr2-R2] the whole final message is the object: nested fences, prose after it and a contradicting note-free body are refused', (t) => {
  const D = digestOf(withResult(narrative(), 'CONVERGED'));
  const good = respond({ request_id: 'req-final', plan_version: 'v2', plan_digest: D, findings: [{ id: 'P1', status: 'confirmed' }] });
  assert.ok(codes(pre(converged(t, { r2: { message: '~~~~text\n~~~\n' + good + '\n~~~~' } }))).includes('debate_response_invalid'), 'a fenced object with a nested fence');
  assert.ok(codes(pre(converged(t, { r2: { message: `${good}\n\nI maintain P1; do not implement.` } }))).includes('debate_response_invalid'), 'a body that contradicts the object');
  assert.ok(codes(pre(converged(t, { r2: { message: good.replace('"status":"confirmed"', '"status":"conceded? No, I maintain it."') } }))).includes('debate_response_invalid'), 'a hedged status');
  assert.deepEqual(pre(converged(t)).errors, [], 'the canonical object verifies');
});

test('[rr2-R2] aliases never launder a concession; fenced Markdown has no effect; two dispositions lines are refused', (t) => {
  const aliased = converged(t, { over: { findings: [FIND({ aliases: ['P9'] })] }, r2: { concede: ['P9'] } });
  assert.ok(codes(pre(aliased)).includes('debate_response_invalid'), 'confirming P9, which no response opened, is refused (aliases are display only)');
  const fenced = converged(t, { narr: narrative({ rows: [['P1', 'accept_risk', 'The owner accepts the residual for this ticket.', 'no']], fenceRows: true }) });
  assert.deepEqual(pre(fenced).errors, [], 'a fenced human-readable table is neither authority nor a refusal');
  const base = withResult(narrative(), 'CONVERGED');
  const line = base.split('\n').find((l) => l.startsWith('debate-dispositions-v1: '));
  const two = converged(t, { narr: base.replace('## 8.', `${line}\n\n## 8.`) });
  assert.ok(codes(pre(two)).includes('debate_attestation_invalid'), 'two dispositions lines');
  const decoy = converged(t, { narr: base.replace('## 8.', `    ${line.replace('"CONVERGED"', '"UNRESOLVED"')}\n\n## 8.`) });
  assert.ok(codes(pre(decoy)).includes('debate_attestation_invalid'), 'an indented decoy counts as a second occurrence of the token');
});

test('[rr2-R3] every retained locator component is checked: a symlinked <TICKET> ancestor holding identical files is refused', { skip: POSIX_ONLY }, (t) => {
  const x = converged(t);
  const dir = retain(t, x);
  const ticketDir = dirname(dir);
  const elsewhere = join(tmp(t, 'debate-elsewhere-'), TICKET);
  assert.equal(spawnSync('cp', ['-R', ticketDir, elsewhere]).status, 0);
  rmSync(ticketDir, { recursive: true, force: true });
  symlinkSync(elsewhere, ticketDir);
  assert.ok(codes(sc(planText(x.narr, [x.line, startLine(x)]), dir)).includes('debate_evidence_mismatch'));
});

test('[rr2-R4] the probe pins the carrier CLI: an absolute --cli, the resolved path recorded, the relay runs the same CLI', { skip: POSIX_ONLY }, (t) => {
  const f = probeFixture(t);
  const rogue = join(f.d, 'rogue');
  mkdirSync(rogue);
  writeFileSync(join(rogue, 'codex'), FAKE_CODEX(0).replace('0.0.0-fake', '9.9.9-rogue'));
  chmodSync(join(rogue, 'codex'), 0o755);
  const out = JSON.parse(probe(f, 'ok', [], { PATH: `${rogue}:${process.env.PATH}` }).stdout);
  assert.equal(out.cli_path, f.codex, 'the resolved executable is recorded');
  assert.equal(out.codex_route.dispatch.result, 'pass', JSON.stringify(out.codex_route.dispatch));
  const other = JSON.parse(probe(f, 'other-cli').stdout);
  assert.equal(other.codex_route.dispatch.result, 'fail', 'the relay reported another CLI version');
  assert.equal(spawnSync(process.execPath, [CLI, 'debate-probe', '--relay', f.relay, '--repo', f.repo, '--out-dir', f.out, '--cli', 'codex']).status, 2, 'a relative --cli is a usage error');
});

test('[rr2-R4] the Claude carrier: resume must stay read-only; cancellation is not applicable (never a pass); auth runs in the repository', { skip: POSIX_ONLY }, (t) => {
  const obs = { carrier: 'claude', relay_present: true, cli_version: { status: 0 }, login: { status: 0, authMethod: 'claude.ai' }, nonce: 'n1',
    dispatch: { result: { status: 'completed', sessionId: 'S', readOnly: true, finalMessage: PROBE_MSG('n1') } }, resume: { result: { status: 'completed', sessionId: 'S', readOnly: false } },
    coverage: { before: 'c', after: 'c', ignored_before: 'i', ignored_after: 'i' } };
  assert.equal(B.classifyProbe(obs).resume.result, 'fail', 'a writable resumed session');
  assert.equal(B.classifyProbe(obs).cancellation.result, 'not_applicable_for_carrier');
  const f = probeFixture(t);
  writeFileSync(join(f.d, 'claude'), FAKE_CLAUDE('claude.ai'));
  chmodSync(join(f.d, 'claude'), 0o755);
  const out = JSON.parse(probe({ ...f, codex: join(f.d, 'claude') }, 'ok', ['--carrier', 'claude'], { FAKE_CARRIER: 'claude' }).stdout);
  assert.equal(out.codex_route.cancellation.result, 'not_applicable_for_carrier');
  assert.equal(out.ok, false, 'an unverified cancellation is never an overall pass');
  for (const k of ['dispatch', 'fresh_result', 'resume', 'coverage']) assert.equal(out.codex_route[k].result, 'pass', `${k}: ${JSON.stringify(out.codex_route[k])}`);
});

test('[rr2-b] a new version may take several exchanges: v1 CR -> v2 CR -> v2 AGREE on the current digest reconfirms a design change', (t) => {
  const rows = [['P3', 'decided', 'Adopt B.', 'yes']];
  const narr = withResult(narrative({ rows }), 'UNRESOLVED');
  const D = digestOf(narr);
  const x = unresolved(t, { narr, r2: { plan_version: 'v2', plan_digest: D, verdict: 'CHANGES_REQUESTED' }, r3: { plan_version: 'v2', plan_digest: D, verdict: 'AGREE', request_id: 'req-3' } });
  assert.deepEqual(codes(sc(planText(x.narr, [x.line, startLine(x)]), retain(t, x))), []);
  const stale = unresolved(t, { narr, r2: { plan_version: 'v1', plan_digest: 'sha256:' + 'c'.repeat(64), verdict: 'CHANGES_REQUESTED' }, r3: { plan_version: 'v1', plan_digest: D, verdict: 'AGREE', request_id: 'req-3' } });
  assert.deepEqual(codes(sc(planText(stale.narr, [stale.line, startLine(stale)]), retain(t, stale))), ['debate_reconfirm_required'], 'the AGREE reuses a version an older digest used');
});

// ================================================================== REAL relay evidence (fixtures/debate-evidence, provenance.json)
// The files are real codex-delegate relay output with privacy redactions (@REPO@, @SCRATCH@, @HOME@). The redacted bytes
// differ from the originals; the tests rebind the path fields and hash what they materialize.
const EVIDENCE = fileURLToPath(new URL('./fixtures/debate-evidence/', import.meta.url));
function materialize(set, bundle, sub, map) {
  const prov = JSON.parse(readFileSync(join(EVIDENCE, 'provenance.json'), 'utf8')).sets[set];
  mkdirSync(join(bundle, sub), { recursive: true });
  const files = {}, hashes = {};
  for (const f of prov.files) {
    let text = readFileSync(join(EVIDENCE, set, f), 'utf8');
    for (const [k, v] of Object.entries(map)) text = text.split(k).join(f.endsWith('.json') || f.endsWith('.jsonl') ? JSON.stringify(v).slice(1, -1) : v);
    writeFileSync(join(bundle, sub, f), text);
    const name = f.replace(/\..*$/, '');
    files[name] = `${sub}/${f}`;
    hashes[name] = sha(Buffer.from(text));
  }
  return { files, hashes, result: JSON.parse(readFileSync(join(bundle, sub, 'result.json'), 'utf8')) };
}
const realRecord = (n, m, o) => ({ n, plan_version: o.plan_version, request_id: o.request_id, status: m.result.status, exit_code: m.result.exitCode, session_id: m.result.threadId,
  read_only: true, verdict: o.verdict, out_dir: 'provenance only', started_at: m.result.startedAt, ended_at: m.result.finishedAt, files: m.files, sha256: m.hashes, ...(o.plan_digest ? { plan_digest: o.plan_digest } : {}) });

const REAL_FIXTURE_DIGEST = 'sha256:61b30a7aba034465f06c0587c7dcb0537b8b5190426db51b826a827259e0a1e6';
test('[a2-real] POSITIVE: a REAL non-dictated counterpart-response-v1 object (outside Plan Mode) verifies; its findings become the derived ledger', (t) => {
  const bundle = tmp(t, 'debate-bundle-');
  const m = materialize('json-2026-11-23', bundle, 'r1', { '@REPO@': REPO, '@SCRATCH@': bundle, '@HOME@': tmpdir() });
  assert.equal(m.result.status, 'completed');
  assert.equal(m.result.sandbox, 'read-only');
  const real = B.parseResponse(m.result.finalMessage, { request_id: 's4-json-2', plan_version: 'v1', plan_digest: REAL_FIXTURE_DIGEST });
  assert.equal(real.ok, true, JSON.stringify(real));
  assert.equal(real.obj.verdict, 'CHANGES_REQUESTED');
  const narr = withResult(narrative(), 'UNRESOLVED');
  const D = digestOf(narr);
  const r1 = realRecord(1, m, { plan_version: 'v1', request_id: 's4-json-2', verdict: 'CHANGES_REQUESTED', plan_digest: REAL_FIXTURE_DIGEST });
  const open = (id) => FIND({ id, status: 'open', closed_by: undefined, closed_round: undefined, evidence: undefined, host_position: 'h', counterpart_position: 'c' });
  const att = attestation({ outcome: 'UNRESOLVED', plan_digest: D, rounds: [r1], findings: [open('P1'), open('P2')], final: null });
  const r = B.debateCheck(planText(narr, [B.serializeAttestation(att)]), { bundleDir: bundle, repo: REPO });
  assert.deepEqual(r.errors, [], 'the real object passes every evidence and schema check: hashes, status, exit 0, bound thread, read-only, workdir, request binding, canonical bytes');
  assert.deepEqual(r.outstanding, ['P1', 'P2']);
  assert.equal(r.debate_qualified, false, 'UNRESOLVED: presentable, never qualified');
  const wrongLedger = attestation({ outcome: 'UNRESOLVED', plan_digest: D, rounds: [r1], findings: [open('P1')], final: null });
  assert.ok(codes(B.debateCheck(planText(narr, [B.serializeAttestation(wrongLedger)]), { bundleDir: bundle, repo: REPO })).includes('debate_attestation_invalid'), 'an attestation ledger that drops P2 is refused');
});

test('[a2-real] NEGATIVE: the real free-text reply and the real dictated object are refused (no free-text fallback; the dictated object lacks v)', (t) => {
  const bundle = tmp(t, 'debate-bundle-');
  const free = materialize('auth-2026-11-22', bundle, 'r1', { '@REPO@': REPO, '@SCRATCH@': bundle, '@HOME@': tmpdir() });
  assert.equal(B.parseResponse(free.result.finalMessage).code, 'debate_response_invalid', 'verdict/request_id/plan_version lines are not the object');
  const narr = withResult(narrative(), 'UNRESOLVED');
  const r1 = realRecord(1, free, { plan_version: 'v1', request_id: 's4-auth-evidence-1', verdict: 'AGREE', plan_digest: OLD_DIGEST });
  const att = attestation({ outcome: 'UNRESOLVED', plan_digest: digestOf(narr), rounds: [r1], findings: [], final: null });
  assert.ok(codes(B.debateCheck(planText(narr, [B.serializeAttestation(att)]), { bundleDir: bundle, repo: REPO })).includes('debate_response_invalid'));
  const dictated = materialize('dictated-2026-11-22', tmp(t, 'debate-bundle-'), 'r1', { '@REPO@': REPO, '@SCRATCH@': bundle, '@HOME@': tmpdir() });
  assert.equal(JSON.parse(dictated.result.finalMessage).v, undefined, 'the dictated object has no v');
  assert.equal(B.parseResponse(dictated.result.finalMessage).code, 'debate_response_invalid');
});

test('[rr2-hist] the historical S4 debate evidence (snapshot cd) stays NON-qualifying: its relay did not run in the repository', (t) => {
  const bundle = tmp(t, 'debate-bundle-');
  const scratch = tmp(t, 'debate-scratch-');
  const m = materialize('s4-r5-historical', bundle, 'r1', { '@SCRATCH@': scratch, '@REPO@': REPO, '@HOME@': tmpdir() });
  writeFileSync(join(bundle, 'r1', 'events.jsonl'), '{"type":"thread.started"}\n');
  m.files.events = 'r1/events.jsonl';
  m.hashes.events = sha(Buffer.from('{"type":"thread.started"}\n'));
  const narr = withResult(narrative(), 'CONVERGED');
  const D = digestOf(narr);
  const r1 = realRecord(1, m, { plan_version: 'v5', request_id: 's4-final-r5-20261122', verdict: 'AGREE', plan_digest: D });
  const att = attestation({ plan_version: 'v5', workdir: m.result.workdir, plan_digest: D, rounds: [r1], findings: [], final: { request_id: 's4-final-r5-20261122', plan_version: 'v5', plan_digest: D, verdict: 'AGREE' } });
  const r = B.debateCheck(planText(narr, [B.serializeAttestation(att)]), { bundleDir: bundle, repo: REPO });
  assert.ok(codes(r).includes('debate_workdir_unbound'), JSON.stringify(r.errors));
  assert.ok(codes(r).includes('debate_response_invalid'), 'its earlier-shape free-text reply is not a counterpart-response-v1 object either');
  assert.equal(r.debate_qualified, false);
});

// ================================================================== review repair 3 (PR #105 at f9be1af): localized defects
test('[rr3-B1] fence context is irrelevant: section 7 inside an enclosing fence neither authorizes nor refuses', (t) => {
  const narr = withResult(narrative(), 'CONVERGED').replace('## 7. Cross-model planning debate', '~~~text\n## 7. Cross-model planning debate').replace('## 8. Proof and review routing\n', '## 8. Proof and review routing\n~~~\n');
  assert.deepEqual(pre(converged(t, { narr })).errors, [], 'the dispositions line is visible and digest-bound inside or outside a fence');
  const balanced = converged(t, { narr: withResult(narrative({ body: 'Do the thing.\n\n```js\nconst a = 1;\n```' }), 'CONVERGED') });
  assert.deepEqual(pre(balanced).errors, [], 'a balanced code block elsewhere in the plan is fine');
});

test('[rr3-B2] inherited GIT_* overrides are scrubbed and the workdir must be a registered worktree of the repository', (t) => {
  const plain = tmp(t, 'debate-plain-');
  const saved = [process.env.GIT_DIR, process.env.GIT_WORK_TREE];
  process.env.GIT_DIR = join(REPO, '.git');
  try {
    assert.ok(codes(pre(converged(t, { over: { workdir: plain }, r1: { workdir: plain }, r2: { workdir: plain } }))).includes('debate_workdir_unbound'), 'GIT_DIR=<target common dir> with an unrelated workdir');
    process.env.GIT_WORK_TREE = plain;
    assert.ok(codes(pre(converged(t, { over: { workdir: plain }, r1: { workdir: plain }, r2: { workdir: plain } }))).includes('debate_workdir_unbound'), 'GIT_DIR plus GIT_WORK_TREE=<the unrelated workdir>');
  } finally {
    if (saved[0] === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved[0];
    if (saved[1] === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = saved[1];
  }
  const wd = tmp(t, 'debate-fakewt-');
  const fake = tmp(t, 'debate-fakegit-');
  writeFileSync(join(fake, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(fake, 'commondir'), `${join(REPO, '.git')}\n`);
  writeFileSync(join(fake, 'gitdir'), `${join(wd, '.git')}\n`);
  writeFileSync(join(wd, '.git'), `gitdir: ${fake}\n`);
  assert.ok(codes(pre(converged(t, { over: { workdir: wd }, r1: { workdir: wd }, r2: { workdir: wd } }))).includes('debate_workdir_unbound'), 'a hand-made gitdir whose commondir points at the repository is not a registered worktree');
});

test('[rr3-B4] the pinned CLI must report a non-empty version that the relay reports too', { skip: POSIX_ONLY }, (t) => {
  const f = probeFixture(t);
  const out = JSON.parse(probe({ ...f, codex: '/usr/bin/true' }, 'ok').stdout);
  assert.equal(out.codex_route.dispatch.result, 'fail', JSON.stringify(out.codex_route.dispatch));
  assert.equal(B.classifyProbe({ relay_present: true, codex_version: { status: 0, version: '', path: '/usr/bin/true' }, login: { status: 0 }, nonce: 'n',
    dispatch: { result: { status: 'completed', threadId: 't', sandbox: 'read-only', codexVersion: '', finalMessage: PROBE_MSG('n') } } }).dispatch.result, 'fail', 'an empty version fails closed');
});

// ================================================================== approved amendment 2026-11-23: RED inputs (recorded before the rewrite)
const R_D = 'sha256:' + '1'.repeat(64);
const resp = (o = {}) => JSON.stringify({ v: 1, request_id: 'req-1', plan_version: 'v1', plan_digest: R_D, verdict: 'CHANGES_REQUESTED', findings: [{ id: 'P1', status: 'new', severity: 'major' }], ...o });
const EXPECT = { request_id: 'req-1', plan_version: 'v1', plan_digest: R_D };
const rcode = (text, expect = EXPECT) => { const r = B.parseResponse(text, expect); return r.ok ? 'ok' : r.code; };

test('[a2-B1b-red] an indented code sample containing ~~~ is never a fence opener (no false refusal)', (t) => {
  const sample = converged(t, { narr: withResult(narrative({ body: 'Do the thing.\n\n    ~~~\n    an indented code sample\n' }), 'CONVERGED') });
  assert.deepEqual(pre(sample).errors, []);
});

test('[a2-B1-red] a fenced Markdown table (4-space pseudo-closer) never authorizes; an indented ~~~ sample never falsely refuses', (t) => {
  const fenced = withResult(narrative({ rows: [['P3', 'accept_risk', 'The owner accepts B is not adopted.', 'no']] }), 'UNRESOLVED', { dispositions: [] })
    .replace('## 7. Cross-model planning debate', '~~~text\n    ~~~\n## 7. Cross-model planning debate');
  const x = unresolved(t, { narr: fenced });
  assert.deepEqual(codes(sc(planText(x.narr, [x.line, startLine(x)]), retain(t, x))), ['debate_disposition_pending'], 'fenced Markdown has no authority');
  const sample = converged(t, { narr: withResult(narrative({ body: 'Do the thing.\n\n    ~~~\n    an indented code sample\n' }), 'CONVERGED') });
  assert.deepEqual(pre(sample).errors, [], 'an indented code sample containing ~~~ is not a fence opener');
});

test('[a2-schema-red] the counterpart response v1: every rejection-table row', () => {
  assert.equal(rcode(resp()), 'ok');
  for (const bad of [`x${resp()}`, `${resp()}\n`, '```json\n' + resp() + '\n```', `﻿${resp()}`, resp({ findings: [{ id: 'P1', status: 'new', severity: 'major', note: 'n'.repeat(2001) }] }), '{"v":1', `${resp()} trailing prose`]) assert.equal(rcode(bad), 'debate_response_invalid', bad.slice(0, 40));
  const big = resp({ findings: Array.from({ length: 12 }, (_, i) => ({ id: `P${i + 1}`, status: 'new', severity: 'minor', note: 'n'.repeat(1990) })) });
  assert.ok(Buffer.byteLength(big) > 16384);
  assert.equal(rcode(big), 'debate_response_invalid', 'over 16 KiB');
  const o = JSON.parse(resp());
  const { v, ...noV } = o;
  for (const bad of [JSON.stringify(noV), JSON.stringify({ ...o, extra: 1 }), resp().replace('"v":1,', '"v":1,"v":1,'), JSON.stringify({ ...o, v: '1' }), JSON.stringify({ ...o, v: 2 }),
    JSON.stringify({ ...o, verdict: 'MAYBE' }), JSON.stringify({ ...o, findings: [{ id: 'P1', status: 'pending', severity: 'major' }] }), JSON.stringify({ ...o, findings: [{ id: 'P1', status: 'new' }] }),
    JSON.stringify({ ...o, findings: [{ id: 'P1', status: 'new', severity: 'major', x: 1 }] }), JSON.stringify({ plan_version: 'v1', v: 1, request_id: 'req-1', plan_digest: R_D, verdict: 'CHANGES_REQUESTED', findings: o.findings }),
    JSON.stringify(o, null, 1), JSON.stringify({ ...o, findings: [{ id: 'P1', status: 'new', severity: 'major' }, { id: 'P1', status: 'new', severity: 'minor' }] }), JSON.stringify({ ...o, plan_version: 'version1' })]) {
    assert.equal(rcode(bad), 'debate_response_invalid', bad.slice(0, 60));
  }
  assert.equal(rcode(resp({ request_id: 'req-9' })), 'debate_request_mismatch');
  assert.equal(rcode(resp({ plan_version: 'v2' })), 'debate_request_mismatch');
  assert.equal(rcode(resp({ plan_digest: 'sha256:' + '2'.repeat(64) })), 'debate_digest_mismatch');
  assert.equal(rcode(resp({ verdict: 'AGREE', findings: [{ id: 'P1', status: 'maintained' }] })), 'debate_response_invalid', 'AGREE with a maintained finding');
  assert.equal(rcode(resp({ verdict: 'AGREE', findings: [{ id: 'P2', status: 'new', severity: 'major' }] })), 'debate_response_invalid', 'AGREE with a new major');
  assert.equal(rcode(resp({ verdict: 'AGREE', findings: [{ id: 'P2', status: 'new', severity: 'minor' }] })), 'ok', 'a new minor does not contradict AGREE');
  assert.equal(rcode(resp({ findings: [{ id: 'P1', status: 'confirmed' }] })), 'debate_response_invalid', 'CHANGES_REQUESTED with nothing open');
  assert.equal(rcode(resp({ verdict: 'AGREE', findings: [{ id: 'P1', status: 'confirmed', note: 'verdict: CHANGES_REQUESTED. I maintain P1; do not implement.' }] })), 'ok', 'note is never parsed');
  assert.equal(B.parseResponseBytes(Buffer.concat([Buffer.from(resp().slice(0, -2)), Buffer.from([0xff]), Buffer.from(resp().slice(-2))]), EXPECT).code, 'debate_response_invalid', 'non-UTF-8 bytes');
  assert.equal(B.parseResponseBytes(Buffer.from(resp()), EXPECT).ok, true);
});

// ================================================================== differential: an independent reference parser vs parseResponse
// The reference is a different mechanism: its own strict tokenizer over the canonical grammar (no whitespace, keys in
// schema order, no duplicate key, canonical string and number encoding), then the same schema, contradiction and binding
// rules. The checker uses JSON.parse plus a schema-ordered rebuild compared byte for byte (its key-tracking guard).
function refParse(text, expect) {
  const NO = 'debate_response_invalid';
  if (Buffer.byteLength(text, 'utf8') > 16384) return NO;
  let i = 0;
  const canonStr = (s) => {
    let out = '"';
    for (let k = 0; k < s.length; k += 1) {
      const c = s.charCodeAt(k);
      const pairOk = c >= 0xd800 && c <= 0xdbff && k + 1 < s.length && s.charCodeAt(k + 1) >= 0xdc00 && s.charCodeAt(k + 1) <= 0xdfff;
      if (s[k] === '"') out += '\\"';
      else if (s[k] === '\\') out += '\\\\';
      else if (c === 8) out += '\\b'; else if (c === 12) out += '\\f'; else if (c === 10) out += '\\n'; else if (c === 13) out += '\\r'; else if (c === 9) out += '\\t';
      else if (c < 0x20) out += `\\u${c.toString(16).padStart(4, '0')}`;
      else if (pairOk) { out += s[k] + s[k + 1]; k += 1; }
      else if (c >= 0xd800 && c <= 0xdfff) out += `\\u${c.toString(16)}`;
      else out += s[k];
    }
    return `${out}"`;
  };
  const value = () => {
    const ch = text[i];
    if (ch === '{') {
      i += 1; const keys = [], obj = {};
      if (text[i] === '}') { i += 1; return { obj, keys }; }
      for (;;) {
        if (text[i] !== '"') throw 0;
        const k = str();
        if (keys.includes(k)) throw 0;
        if (text[i] !== ':') throw 0;
        i += 1; keys.push(k); obj[k] = value();
        if (text[i] === ',') { i += 1; continue; }
        if (text[i] === '}') { i += 1; return { obj, keys }; }
        throw 0;
      }
    }
    if (ch === '[') {
      i += 1; const arr = [];
      if (text[i] === ']') { i += 1; return arr; }
      for (;;) { arr.push(value()); if (text[i] === ',') { i += 1; continue; } if (text[i] === ']') { i += 1; return arr; } throw 0; }
    }
    if (ch === '"') return str();
    const m = /^(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (!m) throw 0;
    i += m[1].length;
    if (m[1] === 'true') return true; if (m[1] === 'false') return false; if (m[1] === 'null') return null;
    if (String(Number(m[1])) !== m[1]) throw 0;
    return Number(m[1]);
  };
  const str = () => {
    const start = i; i += 1; let s = '';
    for (;;) {
      if (i >= text.length) throw 0;
      const c = text[i];
      if (c === '"') { i += 1; break; }
      if (c === '\\') {
        const e = text[i + 1];
        const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (e === 'u') { const h = text.slice(i + 2, i + 6); if (!/^[0-9a-fA-F]{4}$/.test(h)) throw 0; s += String.fromCharCode(parseInt(h, 16)); i += 6; continue; }
        if (!(e in map)) throw 0;
        s += map[e]; i += 2; continue;
      }
      if (c.charCodeAt(0) < 0x20) throw 0;
      s += c; i += 1;
    }
    if (canonStr(s) !== text.slice(start, i)) throw 0;
    return s;
  };
  let root;
  try { root = value(); if (i !== text.length) return NO; } catch { return NO; }
  if (!root || !root.keys) return NO;
  const TOP = ['v', 'request_id', 'plan_version', 'plan_digest', 'verdict', 'findings'];
  if (root.keys.join() !== TOP.join()) return NO;
  const o = root.obj;
  if (o.v !== 1) return NO;
  if (typeof o.request_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(o.request_id)) return NO;
  if (typeof o.plan_version !== 'string' || !/^v[0-9]{1,4}$/.test(o.plan_version)) return NO;
  if (typeof o.plan_digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(o.plan_digest)) return NO;
  if (!['AGREE', 'CHANGES_REQUESTED'].includes(o.verdict)) return NO;
  if (!Array.isArray(o.findings) || o.findings.length > 12) return NO;
  const ids = new Set(), fs = [];
  for (const f of o.findings) {
    if (!f || !f.keys) return NO;
    const order = ['id', 'status', 'severity', 'note'];
    let last = -1;
    for (const k of f.keys) { const at = order.indexOf(k); if (at <= last) return NO; last = at; }
    const v = f.obj;
    if (typeof v.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v.id) || ids.has(v.id)) return NO;
    ids.add(v.id);
    if (!['conceded', 'confirmed', 'maintained', 'new'].includes(v.status)) return NO;
    if ('severity' in v ? !['blocker', 'major', 'minor'].includes(v.severity) : v.status === 'new') return NO;
    if ('note' in v && !(typeof v.note === 'string' && v.note.length <= 2000)) return NO;
    fs.push(v);
  }
  if (o.verdict === 'AGREE' && fs.some((f) => f.status === 'maintained' || (f.status === 'new' && f.severity !== 'minor'))) return NO;
  if (o.verdict === 'CHANGES_REQUESTED' && !fs.some((f) => f.status === 'maintained' || f.status === 'new')) return NO;
  if (expect) {
    if (o.request_id !== expect.request_id || o.plan_version !== expect.plan_version) return 'debate_request_mismatch';
    if (o.plan_digest !== expect.plan_digest) return 'debate_digest_mismatch';
  }
  return 'ok';
}

test('differential: the checker accepts EXACTLY what an independent reference parser accepts over 24,000 generated responses', () => {
  let seed = 0x5eed5;
  const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const ALPHA = ['a', 'Z', '7', ' ', '"', '\\', '\n', '\t', '\u0001', ' ', 'é', '😀', '/', '<', '\ud800'];
  const text = (n) => Array.from({ length: n }, () => (rnd() < 0.9 ? pick(['a', 'b', ' ', 'x']) : pick(ALPHA))).join('');
  const expect = { request_id: 'req-1', plan_version: 'v1', plan_digest: R_D };
  const base = () => {
    const findings = Array.from({ length: Math.floor(rnd() * 5) }, (_, k) => {
      const f = { id: rnd() < 0.97 ? `P${k + 1}` : pick(['P 1', '', '-x', `P${k}`]), status: pick(['conceded', 'confirmed', 'maintained', 'new', 'new']) };
      if (f.status === 'new' || rnd() < 0.3) f.severity = pick(['blocker', 'major', 'minor', 'minor']);
      if (rnd() < 0.5) f.note = text(Math.floor(rnd() * 40));
      return f;
    });
    const verdict = findings.some((f) => f.status === 'maintained' || (f.status === 'new' && f.severity !== 'minor')) ? 'CHANGES_REQUESTED' : pick(['AGREE', 'AGREE', 'CHANGES_REQUESTED']);
    return { v: 1, request_id: rnd() < 0.85 ? 'req-1' : pick(['req-2', '../x', 'r'.repeat(129)]), plan_version: rnd() < 0.9 ? 'v1' : pick(['v2', 'version1', 'v12345']),
      plan_digest: rnd() < 0.9 ? R_D : pick([`sha256:${'2'.repeat(64)}`, 'sha256:abc', R_D.toUpperCase()]), verdict, findings };
  };
  const ser = (o) => JSON.stringify(o);
  const OPS = {
    none: (o) => ser(o),
    prose_before: (o) => `Here: ${ser(o)}`, prose_after: (o) => `${ser(o)}\nI maintain P1; do not implement.`, newline_after: (o) => `${ser(o)}\n`,
    fence: (o) => '```json\n' + ser(o) + '\n```', tilde_fence: (o) => '~~~~text\n~~~\n' + ser(o) + '\n~~~~', bom: (o) => `﻿${ser(o)}`,
    space: (o) => ser(o).replace(':', ': '), pretty: (o) => JSON.stringify(o, null, 1),
    dup_key: (o) => ser(o).replace('{"v":1,', '{"v":1,"v":1,'), extra_key: (o) => ser({ ...o, extra: 1 }), extra_finding_key: (o) => ser({ ...o, findings: [...o.findings, { id: 'P9', status: 'new', severity: 'minor', x: 1 }] }),
    missing_key: (o) => { const c = { ...o }; delete c[pick(Object.keys(c))]; return ser(c); },
    reorder: (o) => ser(Object.fromEntries(Object.entries(o).reverse())), reorder_finding: (o) => ser({ ...o, findings: [{ status: 'new', id: 'P9', severity: 'minor' }] }),
    wrong_type: (o) => ser({ ...o, v: pick(['1', true, 1.5, null]) }), float_v: (o) => ser(o).replace('"v":1,', '"v":1.0,'),
    bad_enum: (o) => ser({ ...o, verdict: pick(['agree', 'MAYBE', '']) }), bad_status: (o) => ser({ ...o, findings: [{ id: 'P9', status: pick(['pending', 'NEW', 'open']), severity: 'minor' }] }),
    no_severity_new: (o) => ser({ ...o, verdict: 'CHANGES_REQUESTED', findings: [{ id: 'P9', status: 'new' }] }),
    long_note: (o) => ser({ ...o, findings: [{ id: 'P9', status: 'new', severity: 'minor', note: 'n'.repeat(1995 + Math.floor(rnd() * 10)) }] }),
    huge: (o) => ser({ ...o, verdict: 'AGREE', findings: Array.from({ length: 12 }, (_, k) => ({ id: `P${k + 1}`, status: 'confirmed', note: 'n'.repeat(1300 + Math.floor(rnd() * 200)) })) }),
    too_many: (o) => ser({ ...o, verdict: 'CHANGES_REQUESTED', findings: Array.from({ length: 13 }, (_, k) => ({ id: `P${k + 1}`, status: 'new', severity: 'minor' })) }),
    agree_contradiction: (o) => ser({ ...o, verdict: 'AGREE', findings: [{ id: 'P9', status: pick(['maintained', 'new']), severity: pick(['major', 'blocker']) }] }),
    cr_contradiction: (o) => ser({ ...o, verdict: 'CHANGES_REQUESTED', findings: [{ id: 'P9', status: 'confirmed' }] }),
    upper_escape: (o) => ser({ ...o, findings: [{ id: 'P9', status: 'new', severity: 'minor', note: '\u0001' }] }).replace('\\u0001', '\\u0001'.toUpperCase().replace('\\U', '\\u')),
    slash_escape: (o) => ser({ ...o, findings: [{ id: 'P9', status: 'new', severity: 'minor', note: 'a/b' }] }).replace('a/b', 'a\\/b'),
    truncate: (o) => ser(o).slice(0, -1 - Math.floor(rnd() * 5)), request_mismatch: (o) => ser({ ...o, request_id: 'req-9' }), digest_mismatch: (o) => ser({ ...o, plan_digest: `sha256:${'3'.repeat(64)}` }),
  };
  const names = Object.keys(OPS);
  const refusedBy = Object.fromEntries(names.map((n) => [n, 0]));
  let accepted = 0, n = 0;
  for (let k = 0; k < 24000; k += 1) {
    const op = names[k % names.length];
    const textIn = OPS[op](base());
    const want = refParse(textIn, expect);
    const r = B.parseResponse(textIn, expect);
    const got = r.ok ? 'ok' : r.code;
    assert.equal(got, want, `${op}: ${JSON.stringify(textIn).slice(0, 200)} :: ${r.why}`);
    if (want === 'ok') accepted += 1; else refusedBy[op] += 1;
    n += 1;
  }
  assert.equal(n, 24000, 'the loop ran every case');
  assert.ok(accepted > 1000, `accepted ${accepted}`);
  for (const op of names.filter((x) => x !== 'none')) assert.ok(refusedBy[op] > 0, `operator ${op} produced a refusal`);
});

// ================================================================== D-A9 (2026-11-23): no hidden markup in a debate_policy 2 narrative
// Raw-substring rule, no Markdown context: every raw `<!--` outside the RUN-STATE body must be followed by `-->` later on the
// SAME line, so a comment can never span (and hide) another line. Only the exact substring `<!--` opens a comment.
const DISPO_LINE = (narr) => narr.split('\n').find((l) => l.startsWith('debate-dispositions-v1: '));
test('[da9] a dispositions line hidden inside a multi-line HTML comment is refused (permanent negative of the hidden-line probe)', (t) => {
  const base = withResult(narrative(), 'CONVERGED');
  const x = converged(t, { narr: base.replace(DISPO_LINE(base), `<!--\n${DISPO_LINE(base)}\n-->`) });
  assert.ok(codes(pre(x)).includes('debate_narrative_hidden_markup'), JSON.stringify(pre(x).errors));
});
test('[da9] multi-line, empty-form and unclosed comments anywhere in the narrative are refused; single-line comments, RUN-STATE and look-alikes are not', (t) => {
  const base = withResult(narrative(), 'CONVERGED');
  const refused = (narr) => codes(pre(converged(t, { narr }))).includes('debate_narrative_hidden_markup');
  assert.ok(refused(base.replace('Do the thing.', 'Do the thing.\n<!-- a note\nthat spans lines -->')), 'a multi-line comment elsewhere');
  assert.ok(refused(base.replace('Do the thing.', 'Do the thing. <!-->')), 'the HTML5 empty comment <!--> has no later --> on the line');
  assert.ok(refused(base.replace('Do the thing.', 'Do the thing. <!--->')), 'nor does <!--->');
  assert.ok(refused(base.replace('Do the thing.', 'Do the thing. <!-- a --> <!-- b')), 'a second opener left unclosed');
  assert.deepEqual(pre(converged(t, { narr: base.replace('Do the thing.', 'Do the thing.\n<!-- security-plan: {"policy":2} -->') })).errors, [], 'a single-line comment such as the mandated security-plan line is allowed');
  assert.deepEqual(pre(converged(t, { narr: base.replace('Do the thing.', 'Do the thing. <!- - and <! -- are not comment openers') })).errors, [], 'only the exact substring <!-- opens a comment');
  const x = converged(t);
  assert.deepEqual(pre(x, planText(x.narr, [x.line, '<!-- a note', 'inside RUN-STATE -->'])).errors, [], 'the RUN-STATE body is out of scope');
  const behind = base.replace(DISPO_LINE(base), `<!-- a --> ${DISPO_LINE(base)}`);
  assert.ok(codes(pre(converged(t, { narr: behind }))).includes('debate_attestation_invalid'), 'a dispositions line behind a single-line comment does not start at column 1');
});
test('[da9] debate-serialize --dispositions prints the canonical line; one of --attestation or --dispositions is required', (t) => {
  const d = tmp(t);
  const obj = dispoFrom({ rows: [['P3', 'accept_risk', 'The owner accepts it.', 'no']] }, 'UNRESOLVED');
  const f = join(d, 'dispo.json');
  writeFileSync(f, JSON.stringify(Object.fromEntries(Object.entries(obj).reverse())));
  const r = run('debate-serialize', '--dispositions', f);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${B.serializeDispositions(obj)}\n`);
  assert.equal(run('debate-serialize', '--dispositions', f, '--attestation', f).status, 2);
  assert.equal(run('debate-serialize').status, 2);
});

// ================================================================== Round 1 (new attempt) repair: B3 whole-value diagnostics
// Each diagnostic source (the relay result's error value; each error event) is classified from ALL its string leaves:
// values AND object keys, at every depth, in arrays, numbers rendered as strings. No field list exists to forget a field.
test('[r1a-probe] fresh_result needs an explicit AGREE: a schema-valid CHANGES_REQUESTED no-op answer is a failure', () => {
  const cr = JSON.stringify({ v: 1, request_id: 'probe-n1', plan_version: 'v1', plan_digest: `sha256:${'0'.repeat(64)}`, verdict: 'CHANGES_REQUESTED', findings: [{ id: 'P1', status: 'new', severity: 'major' }] });
  const obs = { relay_present: true, codex_version: { status: 0 }, login: { status: 0 }, nonce: 'n1', dispatch: { result: { status: 'completed', threadId: 'th-1', sandbox: 'read-only', finalMessage: cr } } };
  assert.equal(B.classifyProbe(obs).fresh_result.result, 'fail');
});

// ================================================================== D-A10 (2026-11-23): no textual limit classification
// LIMIT_REACHED is accepted only for a configured budget. A provider or resource failure is UNRESOLVED with
// incomplete_review: true, the retained relay result showing the actual failure (status not completed, or exit not 0).
const DEEP = (n, leaf) => { let v = leaf; for (let k = 0; k < n; k += 1) v = { a: v }; return v; };
const A10_ATTACKS = {
  hook_warning: { events: '{"type":"item.completed","item":{"type":"error","message":"clamping SessionEnd hook timeout to 3s in hooks.json"}}\n' },
  key_only_rate_limit: { events: '{"type":"error","message":"invalid request","rate_limit":false}\n' },
  eperm_false_key: { events: '{"type":"error","message":"usage limit reached (429)","EPERM":false}\n' },
  code_field: { events: '{"type":"error","message":"usage limit reached (429)","code":"EPERM"}\n' },
  item_error: { events: '{"type":"turn.failed","message":"usage limit reached (429)","item":{"type":"error","error":"EPERM"}}\n' },
  deep_5000: { events: `${JSON.stringify({ type: 'error', nested: DEEP(5000, 'usage limit reached (429)') })}\n` },
};
function incomplete(t, { roundOpts = {}, over = {} } = {}) {
  const narr = withResult(narrative(), 'UNRESOLVED');
  const bundle = tmp(t, 'debate-bundle-');
  const rounds = [round(bundle, 1, { plan_version: 'v1', status: 'failed', ...roundOpts })];
  const att = attestation({ outcome: 'UNRESOLVED', plan_digest: digestOf(narr), rounds, findings: [], final: null, incomplete_review: true, limit: null, ...over });
  const line = B.serializeAttestation(att);
  return { bundle, att, line, narr, D: digestOf(narr), text: planText(narr, [line]) };
}
test('[a10] every Round 1/2 attack input is refused as a provider or resource LIMIT_REACHED (no text is classified)', (t) => {
  for (const [name, a] of Object.entries(A10_ATTACKS)) {
    for (const kind of ['provider_limit', 'resource_limit']) {
      const x = limited(t, { roundOpts: { result_error: 'usage limit reached (429)', ...a }, over: { limit: { kind, evidence: 'usage limit reached (429)' } } });
      assert.ok(codes(pre(x)).includes('debate_limit_invalid'), `${name} ${kind}`);
    }
  }
  const classed = limited(t, { roundOpts: { dispatch_error: { class: 'provider', text: 'spawn failed' } }, over: { limit: { kind: 'provider_limit', evidence: 'spawn failed' } } });
  assert.ok(codes(pre(classed)).includes('debate_limit_invalid'), 'a structured class never promotes text into a limit');
});
test('[a10] a provider or resource failure is UNRESOLVED with incomplete_review, accepted only when the retained relay result shows the failure', (t) => {
  for (const [name, a] of Object.entries(A10_ATTACKS)) {
    const failed = incomplete(t, { roundOpts: a });
    assert.deepEqual(pre(failed).errors, [], `${name}: a failed relay result is retained evidence`);
    assert.equal(pre(failed).debate_qualified, false);
    const completed = incomplete(t, { roundOpts: { ...a, status: 'completed', verdict: 'AGREE', findings: [] } });
    assert.ok(codes(pre(completed)).includes('debate_outcome_invalid'), `${name}: a completed run with exit 0 is not a failure`);
  }
  assert.ok(codes(pre(incomplete(t, { roundOpts: { dispatch_error: { class: 'provider', text: 'spawn failed' } } }))).includes('debate_outcome_invalid'), 'no retained relay result, no failure evidence');
  assert.ok(codes(pre(incomplete(t, { roundOpts: { result_status: 'completed', result_exit: 0 } }))).includes('debate_evidence_mismatch'), 'a fabricated failure record over a completed result');
  assert.ok(codes(pre(incomplete(t, { roundOpts: { status: 'timeout' } }))).length === 0, 'a relay timeout is a failure');
});
test('[a10] the real fixtures (completed runs carrying Codex hook warnings) are never treated as failed', (t) => {
  for (const [set, rid] of [['json-2026-11-23', 's4-json-2'], ['auth-2026-11-22', 's4-auth-evidence-1']]) {
    const bundle = tmp(t, 'debate-bundle-');
    const m = materialize(set, bundle, 'r1', { '@REPO@': REPO, '@SCRATCH@': bundle, '@HOME@': tmpdir() });
    assert.ok(readFileSync(join(bundle, 'r1', 'events.jsonl'), 'utf8').includes('hook'), `${set} carries hook warnings`);
    const narr = withResult(narrative(), 'UNRESOLVED');
    const r1 = realRecord(1, m, { plan_version: 'v1', request_id: rid, verdict: set.startsWith('json') ? 'CHANGES_REQUESTED' : 'AGREE', plan_digest: set.startsWith('json') ? 'sha256:61b30a7aba034465f06c0587c7dcb0537b8b5190426db51b826a827259e0a1e6' : OLD_DIGEST });
    const att = attestation({ outcome: 'UNRESOLVED', plan_digest: digestOf(narr), rounds: [r1], findings: [], final: null, incomplete_review: true, limit: null });
    assert.ok(codes(B.debateCheck(planText(narr, [B.serializeAttestation(att)]), { bundleDir: bundle, repo: REPO })).includes('debate_outcome_invalid'), set);
  }
});
test('[a10] configured_budget is the one LIMIT_REACHED kind: reached and named is accepted, otherwise refused', (t) => {
  const budget = (b, m, ev) => limited(t, { roundOpts: { status: 'completed', verdict: 'CHANGES_REQUESTED' }, over: { findings: [FIND({ status: 'open', closed_by: undefined, closed_round: undefined, evidence: undefined, host_position: 'h', counterpart_position: 'c' })],
    budget: b, metrics: { rounds: m, calls: m, minutes: 9, started_at: '2026-11-22T10:00:00Z', ended_at: '2026-11-22T10:09:00Z', tokens: null }, limit: { kind: 'configured_budget', evidence: ev } } });
  assert.deepEqual(pre(budget({ max_rounds: 1, max_minutes: null }, 1, 'max_rounds: 1 (repository override)')).errors, []);
  assert.ok(codes(pre(budget({ max_rounds: 5, max_minutes: null }, 1, 'max_rounds: 5'))).includes('debate_limit_invalid'), 'not reached');
  assert.ok(codes(pre(budget({ max_rounds: null, max_minutes: null }, 1, 'max_rounds: 1'))).includes('debate_limit_invalid'), 'no configured budget');
});
test('[a10] untrusted JSON depth never overflows the stack: a 5,000-deep attestation, dispositions or response value is refused', (t) => {
  const x = converged(t);
  const deepAtt = B.serializeAttestation.length >= 0 ? `<!-- debate-attestation-v1 ${JSON.stringify({ ...JSON.parse(x.line.slice(27, -4)), deep: DEEP(5000, 1) })} -->` : '';
  let r;
  assert.doesNotThrow(() => { r = pre(x, planText(x.narr, [deepAtt])); });
  assert.ok(codes(r).includes('debate_attestation_invalid'), JSON.stringify(r.errors).slice(0, 200));
  const base = withResult(narrative(), 'CONVERGED');
  const line = base.split('\n').find((l) => l.startsWith('debate-dispositions-v1: '));
  const deepLine = `debate-dispositions-v1: ${JSON.stringify({ ...JSON.parse(line.slice(24)), deep: DEEP(5000, 1) })}`;
  assert.doesNotThrow(() => { r = pre(converged(t, { narr: base.replace(line, deepLine) })); });
  assert.ok(codes(r).includes('debate_attestation_invalid'));
  assert.equal(B.parseResponse(JSON.stringify({ v: 1, request_id: 'r', plan_version: 'v1', plan_digest: R_D, verdict: 'AGREE', findings: [{ id: 'P1', status: 'confirmed', note: DEEP(5000, 'x') }] })).code, 'debate_response_invalid');
  const inField = `debate-dispositions-v1: ${JSON.stringify({ ...JSON.parse(line.slice(24)), dispositions: [{ id: 'P1', kind: 'accept_risk', resolution: DEEP(5000, 'x'), design_change: false }] })}`;
  assert.doesNotThrow(() => { r = pre(converged(t, { narr: base.replace(line, inField) })); }, 'a deep value inside an allowed field reaches the serializer');
  assert.ok(codes(r).includes('debate_attestation_invalid'));
  const attField = `<!-- debate-attestation-v1 ${JSON.stringify({ ...JSON.parse(x.line.slice(27, -4)), findings: [{ ...FIND(), host_position: DEEP(5000, 'x') }] })} -->`;
  assert.doesNotThrow(() => { r = pre(x, planText(x.narr, [attField])); });
  assert.ok(codes(r).includes('debate_attestation_invalid'));
});
test('[a10] start-check: an incomplete review reaches START only through the owner disposition of LIMIT', (t) => {
  const go = (rows) => { const narr = withResult(narrative({ rows }), 'UNRESOLVED'); const x = incomplete(t); const y = { ...x, narr, text: planText(narr, [x.line]) };
    const att = { ...x.att, plan_digest: digestOf(narr) }; const line = B.serializeAttestation(att); const z = { ...y, att, line, D: digestOf(narr), text: planText(narr, [line]) };
    return codes(sc(planText(z.narr, [z.line, startLine(z)]), retain(t, z))); };
  assert.deepEqual(go([]), ['debate_disposition_pending']);
  assert.deepEqual(go([['LIMIT', 'accept_risk', 'The owner accepts planning without a completed counterpart review: quota exhausted.', 'no']]), []);
});
