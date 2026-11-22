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
const carrierSection = ({ degraded = false, degradationAck = 'none', exception = 'none', reason = 'none', exceptionAck = 'none', scope = 'this ticket' } = {}) => [
  '### Debate carrier and exceptions requested',
  `- carrier.degraded: ${degraded}`,
  `- degradation acknowledgement: ${degradationAck}`,
  `- exception: ${exception}`,
  `- exception reason: ${reason}`,
  `- exception acknowledgement: ${exceptionAck}`,
  `- scope: ${scope}`,
  '',
].join('\n');
const dispositionTable = (rows) => (rows.length ? ['| Finding | Disposition | Resolution | Design change |', '|---|---|---|---|',
  ...rows.map((r) => `| ${r.join(' | ')} |`), ''].join('\n') : '');
function narrative({ policy = 'debate_policy: 2', attestationRef = `Attestation: ${DEBATE_ID}`, carrier = {}, rows = [], body = 'Do the thing.' } = {}) {
  return ['---', 'run_id: r1', ...(policy ? [policy] : []), '---', '# Plan — T-1: thing', '', body, '',
    '## 7. Cross-model planning debate', '', ...(attestationRef ? [attestationRef, ''] : []), carrierSection(carrier), dispositionTable(rows),
    '## 8. Proof and review routing', '', 'x', '', ''].join('\n');
}
const planText = (narr, lines = []) => `${narr}${[BEGIN, ...lines, END, ''].join('\n')}`;
/** Section 7 states the outcome in its `**Result:**` line; the helpers add it unless the narrative already has one. */
const withResult = (narr, outcome) => (narr.includes('**Result:**') ? narr : narr.replace('## 7. Cross-model planning debate\n', `## 7. Cross-model planning debate\n\n**Result:** ${outcome}: fixture\n`));
const digestOf = (narr) => B.planDigest(planText(narr));

// ---- the bundle: relay evidence files at bundle-relative paths ------------------------------------------------------
function echo({ verdict = 'AGREE', request_id, plan_version, plan_digest, concede = ['P1'] }) {
  return [`verdict: ${verdict}`, `request_id: ${request_id}`, `plan_version: ${plan_version}`, `plan_digest: ${plan_digest}`, '', ...concede.map((id) => `finding ${id}: confirmed`), 'Findings: none open.'].join('\n');
}
/**
 * Write one round's evidence under <bundle>/r<n>/ and return its attestation record. `kind` picks the carrier shape.
 * Options model the defects: a result that says something else than the record, a missing file, a dispatch failure.
 */
function round(bundle, n, o = {}) {
  const kind = o.kind ?? 'codex_relay';
  const request_id = o.request_id ?? `req-${n}`;
  const plan_version = o.plan_version ?? `v${n}`;
  const plan_digest = o.plan_digest;
  const status = o.status ?? 'completed';
  const verdict = o.verdict ?? (status === 'completed' ? 'CHANGES_REQUESTED' : null);
  const session = o.session ?? 'thread-1';
  const dir = join(bundle, `r${n}`);
  mkdirSync(dir, { recursive: true });
  const rec = { n, plan_version, request_id, status, session_id: session, read_only: o.read_only ?? true, out_dir: `/tmp/relay-out/r${n}`, started_at: o.started_at ?? '2026-11-22T10:00:00Z', ended_at: o.ended_at ?? '2026-11-22T10:05:00Z', files: {}, sha256: {}, verdict };
  if (plan_digest) rec.plan_digest = plan_digest;
  if (o.exit_code !== undefined) rec.exit_code = o.exit_code; else rec.exit_code = status === 'completed' ? 0 : 1;
  if (o.dispatch_error) { rec.dispatch_error = o.dispatch_error; rec.files = {}; rec.sha256 = {}; delete rec.session_id; return rec; }
  const briefText = o.brief ?? [`request_id: ${request_id}`, `plan_version: ${plan_version}`, ...(plan_digest ? [`plan_digest: ${plan_digest}`] : []), '', 'Challenge the plan.'].join('\n');
  const message = o.message ?? (status === 'completed' ? echo({ verdict, request_id: o.echo_request_id ?? request_id, plan_version, plan_digest: o.echo_digest ?? plan_digest ?? 'sha256:none', concede: o.concede }) : '');
  const put = (name, file, text) => { writeFileSync(join(dir, file), text); rec.files[name] = `r${n}/${file}`; rec.sha256[name] = sha(Buffer.from(text)); };
  if (kind === 'native_session') {
    put('message', 'message.txt', message);
    return rec;
  }
  put('brief', 'brief.txt', briefText);
  const resultStatus = o.result_status ?? (status === 'unavailable' ? 'codex_unavailable' : status);
  const result = kind === 'claude_relay'
    ? { schema: 1, tool: 'claude', workdir: o.workdir ?? WORKDIR, readOnly: o.readOnly ?? true, sessionId: o.result_session ?? session, status: resultStatus, exitCode: o.result_exit ?? rec.exit_code, finalMessage: message }
    : { schema: 1, workdir: o.workdir ?? WORKDIR, sandbox: o.sandbox ?? 'read-only', threadId: o.result_session ?? session, status: resultStatus, exitCode: o.result_exit ?? rec.exit_code, finalMessage: message, ...(status !== 'completed' ? { error: o.result_error ?? 'usage limit reached (429)' } : {}) };
  if (kind === 'claude_relay') rec.auth_method = o.auth_method ?? 'claude.ai';
  if (o.omitIds) { delete result.exitCode; delete result.threadId; delete result.sessionId; delete rec.exit_code; delete rec.session_id; }
  if (!o.noResult) put('result', 'result.json', JSON.stringify(result));
  put('events', 'events.jsonl', '{"type":"thread.started"}\n');
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
  const x3 = converged(t, { over: { findings: [FIND({ id: 'P9', severity: 'blocker', status: 'open', closed_by: undefined, closed_round: undefined })] } });
  assert.ok(codes(pre(x3)).includes('debate_open_finding'), 'an open blocker');
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
  assert.ok(codes(pre(x3)).includes('debate_echo_invalid'), 'substring AGREE without the anchored echo lines');
  const dup = `${echo({ request_id: 'req-final', plan_version: 'v2', plan_digest: 'sha256:x' })}\nverdict: AGREE`;
  const x4 = converged(t, { r2: { message: dup } });
  assert.ok(codes(pre(x4)).includes('debate_echo_invalid'), 'a duplicated echo key');
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
function unresolved(t, { narr: n0 = narrative(), over = {}, findings, r2 = {} } = {}) {
  const narr = withResult(n0, 'UNRESOLVED');
  const bundle = tmp(t, 'debate-bundle-');
  const D = digestOf(narr);
  const rounds = [round(bundle, 1, { plan_version: 'v1' }), round(bundle, 2, { plan_version: 'v2', plan_digest: 'sha256:' + 'b'.repeat(64), ...r2 })];
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

test('LIMIT_REACHED: first-dispatch quota failure with empty findings is valid, with or without a result file', (t) => {
  const withFile = limited(t);
  assert.deepEqual(pre(withFile).errors, []);
  assert.equal(pre(withFile).debate_qualified, false);
  const noFile = limited(t, { roundOpts: { dispatch_error: { class: 'provider', text: 'codex exited before writing result.json: usage limit' } } });
  assert.deepEqual(pre(noFile).errors, []);
  const nothing = limited(t, { roundOpts: { noResult: true } });
  assert.ok(codes(pre(nothing)).includes('debate_evidence_missing'), 'no result file and no dispatch-failure evidence');
  const notIncomplete = limited(t, { over: { incomplete_review: false } });
  assert.ok(codes(pre(notIncomplete)).includes('debate_limit_invalid'), 'empty findings must say incomplete_review');
  const claimsConverged = limited(t, { over: { final: { request_id: 'req-1', plan_version: 'v1', plan_digest: 'sha256:x', verdict: 'AGREE' } } });
  assert.ok(codes(pre(claimsConverged)).includes('debate_outcome_invalid'), 'LIMIT_REACHED is never converted to CONVERGED');
  const qualifiedClaim = limited(t, { over: { debate_qualified: true } });
  assert.ok(codes(pre(qualifiedClaim)).includes('debate_outcome_invalid'), 'an attestation may not self-declare qualification');
  const noKind = limited(t, { over: { limit: { kind: 'tired', evidence: 'x' } } });
  assert.ok(codes(pre(noKind)).includes('debate_limit_invalid'));
  const fakeSuccess = limited(t, { roundOpts: { result_status: 'completed', result_exit: 0 } });
  assert.ok(codes(pre(fakeSuccess)).includes('debate_evidence_mismatch'), 'a failed attempt keeps its actual relay status');
});

test('LIMIT_REACHED: configured_budget needs the configured value and its being reached; provider_limit needs the error text', (t) => {
  const ok = limited(t, { roundOpts: { status: 'completed', verdict: 'CHANGES_REQUESTED' }, over: { budget: { max_rounds: 1, max_minutes: null }, metrics: { rounds: 1, calls: 1, minutes: 9, started_at: '2026-11-22T10:00:00Z', ended_at: '2026-11-22T10:09:00Z', tokens: null }, limit: { kind: 'configured_budget', evidence: 'max_rounds: 1 (repository override)' } } });
  assert.deepEqual(pre(ok).errors, []);
  const noBudget = limited(t, { roundOpts: { status: 'completed' }, over: { limit: { kind: 'configured_budget', evidence: 'max_rounds: 1' } } });
  assert.ok(codes(pre(noBudget)).includes('debate_limit_invalid'), 'no configured budget');
  const notReached = limited(t, { roundOpts: { status: 'completed' }, over: { budget: { max_rounds: 5, max_minutes: null }, limit: { kind: 'configured_budget', evidence: 'max_rounds: 5' } } });
  assert.ok(codes(pre(notReached)).includes('debate_limit_invalid'), 'the budget was not reached');
  const noText = limited(t, { over: { limit: { kind: 'provider_limit', evidence: '' } } });
  assert.ok(codes(pre(noText)).includes('debate_limit_invalid'));
  const providerButCompleted = limited(t, { roundOpts: { status: 'completed' } });
  assert.ok(codes(pre(providerButCompleted)).includes('debate_limit_invalid'), 'a provider limit needs a failed, timed-out, aborted or unavailable last attempt');
});

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
  const rounds = [round(bundle, 1, { kind: 'native_session', plan_version: 'v1', session: 'host-session-1' })];
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
    variants.push(unresolved(t, { findings: [FIND({ id: 'P1', severity: sev, status: 'open', closed_by: undefined, closed_round: undefined, host_position: 'h', counterpart_position: 'c' })] }));
  }
  for (const status of ['failed', 'timeout', 'aborted', 'unavailable']) variants.push(limited(t, { roundOpts: { status } }));
  variants.push(limited(t, { roundOpts: { dispatch_error: { class: 'provider', text: 'quota' } } }));
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
  assert.deepEqual(go([['P3', 'decide', 'the owner decides later', 'no']]), ['debate_disposition_pending']);
  assert.deepEqual(go([['P3', 're-debate', 'ask Codex again', 'no']]), ['debate_disposition_pending']);
  assert.deepEqual(go([['P3', 'accept_risk', '', 'no']]), ['debate_disposition_pending'], 'empty resolution');
  assert.deepEqual(go([['P3', 'accept_risk', '<the accepted-risk text>', 'no']]), ['debate_disposition_pending'], 'a placeholder');
  assert.deepEqual(go([['P3', 'accept_risk', 'The owner accepts that B is not adopted for this ticket.', 'no']]), []);
  assert.deepEqual(go([['P3', 'decided', 'Keep A: the importer depends on it.', 'no']]), []);
  assert.deepEqual(go([['P3', 'decided', 'Adopt B.', 'yes']]), ['debate_reconfirm_required']);
  assert.deepEqual(go([['P3', 'waived', 'Out of scope by exception.', 'no']]), ['debate_disposition_pending'], 'waived needs the frozen exception');
});

test('start-check: LIMIT_REACHED needs an owner disposition of the limit; SKIPPED with its exception may START', (t) => {
  const lx = (rows) => { const x = limited(t, { narr: narrative({ rows }) }); return codes(sc(planText(x.narr, [x.line, startLine(x)]), retain(t, x))); };
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
  const okObs = { relay_present: true, codex_version: { status: 0 }, login: { status: 0 }, dispatch: { result: { status: 'completed', threadId: 'th-1', sandbox: 'read-only', finalMessage: 'probe-ok n1' } }, nonce: 'n1',
    resume: { result: { status: 'completed', threadId: 'th-1' } }, cancel: { child_seen: true, result: { status: 'timeout' }, survivors: [] }, coverage: { before: 'c1', after: 'c1', ignored_before: 'i', ignored_after: 'i' } };
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
  assert.equal(cls({ dispatch: { result: { status: 'completed', threadId: '', sandbox: 'read-only', finalMessage: 'probe-ok n1' } } }).fresh_result.result, 'fail');
  assert.equal(cls({ resume: { result: { status: 'completed', threadId: 'th-2' } } }).resume.result, 'fail', 'resume must return the same thread');
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
const write = (o) => {
  const { threadId, ...rest } = o;
  const shaped = claude ? { workdir: cd, readOnly: a.includes('--read-only'), sessionId: threadId, ...rest } : { workdir: cd, sandbox: a.includes('--read-only') ? 'read-only' : 'workspace-write', threadId, ...rest };
  writeFileSync(join(out, 'result.json'), JSON.stringify(shaped));
};
if (mode === 'mutate') appendFileSync(join(cd, 'untracked.txt'), 'changed by the relay');
// like the real relay's \`codex --version\` and \`git status\` helpers: an ordinary, non-detached child in the relay's group
if (mode === 'helper') spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 400)']);
const nonce = (/probe-ok (\\S+)/.exec(brief) || [])[1] || '';
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
  write({ status: 'completed', exitCode: 0, threadId: thread, finalMessage: 'probe-ok ' + nonce });
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
  ['digest binding', 'if (final.plan_digest !== digest) add(\'debate_digest_mismatch\'', 'if (false) add(\'debate_digest_mismatch\'',
    (t) => { const x = converged(t); return { x, text: planText(narrative({ body: 'Edited.' }), [x.line]), code: 'debate_digest_mismatch' }; }],
  ['evidence hash', 'if (sha256Of(bytes) !== want) add(\'debate_evidence_mismatch\'', 'if (false) add(\'debate_evidence_mismatch\'',
    (t) => { const x = converged(t); writeFileSync(join(x.bundle, 'r2', 'events.jsonl'), 'x'); return { x, code: 'debate_evidence_mismatch' }; }],
  ['request echo', 'if (echoed.request_id !== r.request_id) add(\'debate_request_mismatch\'', 'if (false) add(\'debate_request_mismatch\'',
    (t) => ({ x: converged(t, { r2: { echo_request_id: 'req-1' } }), code: 'debate_request_mismatch' })],
  ['anchored echo grammar', 'const ECHO_LINE = /^(verdict|request_id|plan_version|plan_digest): (\\S+)$/;', 'const ECHO_LINE = /(verdict|request_id|plan_version|plan_digest):? (\\S+)/;',
    (t) => ({ x: converged(t, { r2: { message: `I say verdict AGREE\nthe request_id req-final\nplan_version v2 here\nplan_digest ${digestOf(narrative())} too` } }), code: 'debate_echo_invalid' })],
  ['read-only sandbox', "if (res.sandbox !== 'read-only')", 'if (false)',
    (t) => ({ x: converged(t, { r2: { sandbox: 'workspace-write' } }), code: 'debate_carrier_invalid' })],
  ['workdir', 'if (resolve(String(res.workdir)) !== resolve(String(att.workdir)))', 'if (false)',
    (t) => ({ x: converged(t, { r2: { workdir: resolve(tmpdir(), 'elsewhere') } }), code: 'debate_carrier_invalid' })],
  ['open blocker', "if (open.some((f) => f.severity === 'blocker' || f.severity === 'major')) add('debate_open_finding'", "if (false) add('debate_open_finding'",
    (t) => ({ x: converged(t, { over: { findings: [FIND({ severity: 'blocker', status: 'open', closed_by: undefined, closed_round: undefined })] } }), code: 'debate_open_finding' })],
  ['limit never converged', "if (att.final !== null) add('debate_outcome_invalid', 'LIMIT_REACHED", "if (false) add('debate_outcome_invalid', 'LIMIT_REACHED",
    (t) => ({ x: limited(t, { over: { final: { request_id: 'req-1', plan_version: 'v1', plan_digest: 'sha256:x', verdict: 'AGREE' } } }), code: 'debate_outcome_invalid' })],
  ['skip exception', "if (!exceptionOk(sec, 'SKIPPED')) add('debate_exception_missing'", "if (false) add('debate_exception_missing'",
    (t) => ({ x: skipped(t, { carrier: {} }), code: 'debate_exception_missing' })],
  ['degradation acknowledgement', "if (att.carrier.degraded && !(sec.degraded === 'true' && sec.degradationAck === DEGRADED_ACK)) add('debate_degradation_unacknowledged'", "if (false) add('debate_degradation_unacknowledged'",
    (t) => ({ x: converged(t, { over: { carrier: { agent: 'codex', kind: 'codex_relay', identity: 'codex:gpt-5.5', degraded: true } } }), code: 'debate_degradation_unacknowledged' })],
  ['replayed request_id', "if (seen.has(r.request_id)) add('debate_request_mismatch'", "if (false) add('debate_request_mismatch'",
    (t) => ({ x: converged(t, { r1: { request_id: 'req-final' } }), code: 'debate_request_mismatch' })],
  ['carrier pairing', "if (!carrier.degraded && (carrier.agent !== PAIRED[host.agent] || base.diversity === 'same_provider')) {", 'if (false) {',
    (t) => ({ x: converged(t, { over: { carrier: { agent: 'claude', kind: 'claude_relay', identity: 'claude:opus-5-5', degraded: false } }, r1: { kind: 'claude_relay', session: 's' }, r2: { kind: 'claude_relay', session: 's' } }), code: 'debate_carrier_invalid' })],
  ['Claude subscription auth', "if (r.auth_method !== 'claude.ai') add('debate_carrier_invalid'", "if (false) add('debate_carrier_invalid'",
    (t) => ({ x: converged(t, { over: { host: { agent: 'codex', identity: 'codex:gpt-5.5' }, carrier: { agent: 'claude', kind: 'claude_relay', identity: 'claude:opus-5-5', degraded: false } }, r1: { kind: 'claude_relay', session: 's' }, r2: { kind: 'claude_relay', session: 's', auth_method: 'api_key' } }), code: 'debate_carrier_invalid' })],
  ['configured budget reached', "else if (!configured.some(([v, u]) => typeof u === 'number' && u >= v && L.evidence.includes(String(v)))) add('debate_limit_invalid'", "else if (false) add('debate_limit_invalid'",
    (t) => ({ x: limited(t, { roundOpts: { status: 'completed' }, over: { budget: { max_rounds: 5, max_minutes: null }, limit: { kind: 'configured_budget', evidence: 'max_rounds: 5' } } }), code: 'debate_limit_invalid' })],
  ['provider limit needs a failed attempt', "} else if (!last || last.status === 'completed') add('debate_limit_invalid'", "} else if (false) add('debate_limit_invalid'",
    (t) => ({ x: limited(t, { roundOpts: { status: 'completed', message: `${echo({ verdict: 'CHANGES_REQUESTED', request_id: 'req-1', plan_version: 'v1', plan_digest: 'sha256:none' })}\nusage limit reached (429)` } }), code: 'debate_limit_invalid' })],
  ['empty findings need incomplete_review', "if (!findings.length && att.incomplete_review !== true) add('debate_limit_invalid'", "if (false) add('debate_limit_invalid'",
    (t) => ({ x: limited(t, { over: { incomplete_review: false } }), code: 'debate_limit_invalid' })],
  ['UNRESOLVED needs an outstanding finding', "if (!open.length || open.some((f) => !nonEmpty(f.host_position) || !nonEmpty(f.counterpart_position))) add('debate_outcome_invalid'", "if (false) add('debate_outcome_invalid'",
    (t) => ({ x: unresolved(t, { findings: [FIND()] }), code: 'debate_outcome_invalid' })],
  ['canonical attestation bytes', 'if (again !== line) return bad(', 'if (false) return bad(',
    (t) => { const x = converged(t); return { x, text: planText(x.narr, [x.line.replace('{"', '{ "')]), code: 'debate_attestation_invalid' }; }],
  ['workdir bound to the repository', "if (realOr(att.workdir) !== root) add('debate_workdir_unbound'", "if (false) add('debate_workdir_unbound'",
    (t) => { const o = tmp(t, 'unrelated-'); return { x: converged(t, { over: { workdir: o }, r1: { workdir: o }, r2: { workdir: o } }), code: 'debate_workdir_unbound' }; }],
  ['completed round exit code 0', "if (r.status === 'completed' && (r.exit_code !== 0 || res.exitCode !== 0)) add('debate_evidence_mismatch'", "if (false) add('debate_evidence_mismatch'",
    (t) => ({ x: converged(t, { r2: { exit_code: 7 } }), code: 'debate_evidence_mismatch' })],
  ['completed round session id', "if (r.status === 'completed' && !nonEmpty(r.session_id)) add('debate_carrier_invalid'", "if (false) add('debate_carrier_invalid'",
    (t) => ({ x: converged(t, { r2: { omitIds: true } }), code: 'debate_carrier_invalid' })],
  ['every round read-only', "if (r.read_only !== true) add('debate_carrier_invalid'", "if (false) add('debate_carrier_invalid'",
    (t) => ({ x: converged(t, { over: { host: { agent: 'codex', identity: 'codex:gpt-5.5' }, carrier: { agent: 'claude', kind: 'native_session', identity: 'claude:opus-5-5', degraded: false } }, r1: { kind: 'native_session', session: 's1' }, r2: { kind: 'native_session', session: 's1', read_only: false } }), code: 'debate_carrier_invalid' })],
  ['owner closure validated', "if (p) add(p[0], `${f.severity} ${f.id} closed by the owner", "if (false) add(p[0], `${f.severity} ${f.id} closed by the owner",
    (t) => ({ x: converged(t, { narr: narrative({ rows: [['P1', 'waived', 'Out of scope.', 'yes']] }), over: { findings: [FIND({ closed_by: 'owner', closed_round: undefined, evidence: undefined })] } }), code: 'debate_disposition_pending' })],
  ['counterpart closure cites a concession', 'names.some((n) => conceded?.has(n))', 'true',
    (t) => ({ x: converged(t, { r2: { concede: [] } }), code: 'debate_attestation_invalid' })],
  ['no symlink inside a bundle', "if (lstatSync(p).isSymbolicLink()) return { code: 'debate_evidence_mismatch'", "if (false) return { code: 'debate_evidence_mismatch'",
    (t) => { const x = converged(t); spawnSync('mv', [join(x.bundle, 'r2'), join(x.bundle, 'r2real')]); symlinkSync('r2real', join(x.bundle, 'r2')); return { x, code: 'debate_evidence_mismatch' }; }],
  ['limit evidence quoted from diagnostics', "if (!d.includes(L.evidence.trim())) add('debate_limit_invalid'", "if (false) add('debate_limit_invalid'",
    (t) => ({ x: limited(t, { over: { limit: { kind: 'provider_limit', evidence: 'quota exhausted at 3am' } } }), code: 'debate_limit_invalid' })],
  ['provider limit needs provider diagnostics', "if (L.kind === 'provider_limit' && !providerish) add('debate_limit_invalid'", "if (false) add('debate_limit_invalid'",
    (t) => ({ x: limited(t, { roundOpts: { result_error: 'EPERM: operation not permitted' }, over: { limit: { kind: 'provider_limit', evidence: 'EPERM: operation not permitted' } } }), code: 'debate_limit_invalid' })],
  ['narrative Result matches the outcome', "if (declared !== outcome) add('debate_outcome_invalid'", "if (false) add('debate_outcome_invalid'",
    (t) => ({ x: converged(t, { narr: withResult(narrative(), 'UNRESOLVED') }), code: 'debate_outcome_invalid' })],
  ['fenced echo is not an echo', "if (/^\\s*(```|~~~)/.test(l)) { fence = !fence; continue; }", 'if (false) { fence = !fence; continue; }',
    (t) => { const D = digestOf(withResult(narrative(), 'CONVERGED')); return { x: converged(t, { r2: { message: '```\n' + echo({ request_id: 'req-final', plan_version: 'v2', plan_digest: D }) + '\n```' } }), code: 'debate_echo_invalid' }; }],
  ['{-leading attestation refused', "if (R.events.some((e) => Object.hasOwn(e, 'debate-attestation-v1') || Object.hasOwn(e, 'debate_id'))) {", 'if (false) {',
    (t) => { const x = converged(t); return { x, text: planText(x.narr, [JSON.stringify({ debate_id: DEBATE_ID, outcome: 'CONVERGED' })]), code: 'debate_attestation_invalid' }; }],
];
const OTHER_MUTANTS = [
  ['probe: failed process listing', ": c.listing_failed ? no('relay'", ": false ? no('relay'",
    (mod) => mod.classifyProbe({ relay_present: true, codex_version: { status: 0 }, login: { status: 0 }, nonce: 'n', dispatch: { result: { status: 'completed', threadId: 't', sandbox: 'read-only', finalMessage: 'probe-ok n' } },
      resume: { result: { status: 'completed', threadId: 't' } }, cancel: { child_seen: true, listing_failed: true, result: { status: 'timeout' }, survivors: [] }, coverage: {} }).cancellation.result === 'fail'],
  ['probe: Claude subscription auth', "else if (claude && o.login.authMethod !== 'claude.ai') dispatch = no('auth'", "else if (false) dispatch = no('auth'",
    (mod) => mod.classifyProbe({ carrier: 'claude', relay_present: true, cli_version: { status: 0 }, login: { status: 0, authMethod: 'api_key' }, nonce: 'n', dispatch: { result: { status: 'completed', sessionId: 's', readOnly: true, finalMessage: 'probe-ok n' } } }).dispatch.result === 'fail'],
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
  ['pending disposition', "if (!CONCRETE.has(row.disposition) || placeholder(row.resolution)) return ['debate_disposition_pending'", "if (false) return ['debate_disposition_pending'",
    (t) => { const x = unresolved(t, { narr: narrative({ rows: [['P3', 'decide', 'later', 'no']] }) }); return { x, code: 'debate_disposition_pending' }; }],
  ['attestation hash at START', "if (start.debate_attestation_sha256 !== got.sha256) add('debate_attestation_changed'", "if (false) add('debate_attestation_changed'",
    (t) => { const x = converged(t); const changed = B.serializeAttestation({ ...x.att, metrics: { ...x.att.metrics, minutes: 99 } }); return { x, lines: [changed], code: 'debate_attestation_changed' }; }],
  ['policy applicability', "if (!debateLegacyApproval(start)) add('debate_policy_missing'", "if (false) add('debate_policy_missing'",
    (t) => { const narr = narrative({ policy: null }); return { x: { narr, D: digestOf(narr), line: null, att: null }, noStartHash: true, code: 'debate_policy_missing' }; }],
  ['design change needs reconfirmation', "if (design === 'yes' && !reconfirmed(rounds, digest)) return ['debate_reconfirm_required'", "if (false) return ['debate_reconfirm_required'",
    (t) => ({ x: unresolved(t, { narr: narrative({ rows: [['P3', 'decided', 'Adopt B.', 'yes']] }) }), code: 'debate_reconfirm_required' })],
  ['design change cell is exactly yes or no', "if (design !== 'yes' && design !== 'no') return ['debate_disposition_pending'", "if (false) return ['debate_disposition_pending'",
    (t) => ({ x: unresolved(t, { narr: narrative({ rows: [['P3', 'decided', 'add field Y', 'yes, adds field Y']] }) }), code: 'debate_disposition_pending' })],
  ['START needs the attestation hash', "if (!nonEmpty(start.debate_attestation_sha256)) { put('debate_attestation_missing'", "if (false) { put('debate_attestation_missing'",
    (t) => { const x = converged(t); return { x, startOver: { debate_attestation_sha256: undefined }, code: 'debate_attestation_missing' }; }],
];
for (const [name, find, replace, make] of START_MUTANTS) {
  test(`mutation (START): ${name} — the mutant accepts the defect, the real start-check refuses it`, async (t) => {
    const m = await mutant(find, replace);
    const { x, lines, code, noStartHash, startOver } = make(t);
    const dir = x.att ? retain(t, x) : null;
    const s = noStartHash ? JSON.stringify({ run_id: 'r1', event: 'START', approved_plan_digest: x.D, approved_at: AFTER, approved_by: 'o' }) : startLine(x, startOver);
    const text = planText(x.narr, [...(lines ?? (x.line ? [x.line] : [])), s]);
    assert.ok(codes(B.startCheck(text, { runId: 'r1', now: NOW, bundleDir: dir, repo: REPO })).includes(code));
    assert.ok(!codes(m.startCheck(text, { runId: 'r1', now: NOW, bundleDir: dir, repo: REPO })).includes(code));
  });
}

// ================================================================== review repair 1 (PR #105): RED on each failing input first
const lsTree = (dir) => Object.fromEntries(spawnSync('git', ['-C', dir, 'ls-tree', 'HEAD'], { encoding: 'utf8' }).stdout.trim().split('\n').map((l) => { const [meta, name] = l.split('\t'); return [name, meta.split(' ')[2]]; }));
const headOf = (dir) => spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
function snapshotOf(t, paths) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'debate-snap-')));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  for (const args of [['init', '-q'], ['config', 'user.email', 'p@example.invalid'], ['config', 'user.name', 'p'], ['config', 'commit.gpgsign', 'false']]) assert.equal(spawnSync('git', ['-C', d, ...args]).status, 0);
  for (const p of paths) assert.equal(spawnSync('cp', ['-R', join(REPO, p), join(d, p)]).status, 0);
  assert.equal(spawnSync('git', ['-C', d, 'add', '-A']).status, 0);
  assert.equal(spawnSync('git', ['-C', d, 'commit', '-qm', 'snapshot']).status, 0);
  return d;
}

test('[rr1-1] the relay workdir is bound to the repository: an unrelated directory named by both the result and the attestation is refused', (t) => {
  const other = tmp(t, 'unrelated-');
  const x = converged(t, { over: { workdir: other }, r1: { workdir: other }, r2: { workdir: other } });
  assert.ok(codes(pre(x)).includes('debate_workdir_unbound'), JSON.stringify(pre(x).errors));
  const common = tmp(t, 'debate-common-');
  assert.equal(B.retainBundle(x.text, { from: x.bundle, to: B.debateLocator(common, TICKET, DEBATE_ID), root: common, repo: REPO }).ok, false, 'debate-retain refuses it');
  const z = converged(t);
  assert.ok(codes(B.debateCheck(z.text, { bundleDir: z.bundle })).includes('debate_workdir_unbound'), 'without --repo the workdir is unbound, never assumed');
});

test('[rr1-1] snapshot workdir: a git snapshot whose top-level entries equal the repository tree at base binds; mismatches are refused', { skip: POSIX_ONLY }, (t) => {
  const snap = snapshotOf(t, ['skills']);
  const base = headOf(REPO);
  const mk = (snapshot, wd = snap) => converged(t, { over: { workdir: wd, workdir_kind: 'snapshot', snapshot }, r1: { workdir: wd }, r2: { workdir: wd } });
  assert.deepEqual(pre(mk({ base, entries: lsTree(snap) })).errors, []);
  assert.ok(codes(pre(mk({ base, entries: { skills: 'f'.repeat(40) } }))).includes('debate_workdir_unbound'), 'entry differs from the repository at base');
  assert.ok(codes(pre(mk({ base: 'e'.repeat(40), entries: lsTree(snap) }))).includes('debate_workdir_unbound'), 'base not in the repository');
  const empty = tmp(t, 'unrelated-');
  assert.ok(codes(pre(mk({ base, entries: lsTree(snap) }, empty))).includes('debate_workdir_unbound'), 'an existing workdir that is not that snapshot');
  writeFileSync(join(snap, 'skills', 'b.txt'), 'changed\n');
  assert.equal(spawnSync('git', ['-C', snap, 'commit', '-qam', 'x']).status, 0);
  assert.ok(codes(pre(mk({ base, entries: { skills: lsTree(REPO).skills } }))).includes('debate_workdir_unbound'), 'the snapshot no longer holds those entries');
});

test('[rr1-2] design change must be exactly yes or no; yes needs a NEW plan_version and an AGREE for the current digest', (t) => {
  const go = (rows, r2) => {
    const narr = withResult(narrative({ rows }), 'UNRESOLVED');
    const D = digestOf(narr);
    const x = unresolved(t, { narr, r2: typeof r2 === 'function' ? r2(D) : r2 });
    return codes(sc(planText(x.narr, [x.line, startLine(x)]), retain(t, x)));
  };
  assert.deepEqual(go([['P3', 'decided', 'add field Y', 'yes, adds field Y']], {}), ['debate_disposition_pending'], 'anything but yes/no fails closed');
  assert.deepEqual(go([['P3', 'decided', 'add field Y', 'maybe']], {}), ['debate_disposition_pending']);
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

test('[rr1-5] closures: an owner closure goes through disposition validation; a counterpart closure must cite a round that conceded that id', (t) => {
  const owner = FIND({ closed_by: 'owner', closed_round: undefined, evidence: undefined });
  const waived = converged(t, { narr: narrative({ rows: [['P1', 'waived', 'Out of scope.', 'yes']] }), over: { findings: [owner] } });
  assert.equal(pre(waived).ok, false, 'waived without the frozen exception');
  assert.ok(codes(pre(waived)).includes('debate_disposition_pending'));
  const accepted = converged(t, { narr: narrative({ rows: [['P1', 'accept_risk', 'The owner accepts the residual for this ticket.', 'no']] }), over: { findings: [owner] } });
  assert.deepEqual(pre(accepted).errors, []);
  const silent = converged(t, { r2: { concede: [] } });
  assert.ok(codes(pre(silent)).includes('debate_attestation_invalid'), 'round 2 never conceded P1');
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

test('[rr1-7] limit evidence must occur in the retained diagnostics and match the limit kind', (t) => {
  const eperm = 'EPERM: operation not permitted';
  assert.ok(codes(pre(limited(t, { roundOpts: { result_error: eperm } }))).includes('debate_limit_invalid'), 'quota text not in the diagnostics');
  assert.ok(codes(pre(limited(t, { roundOpts: { result_error: eperm }, over: { limit: { kind: 'provider_limit', evidence: eperm } } }))).includes('debate_limit_invalid'), 'EPERM is not a provider limit');
  assert.deepEqual(pre(limited(t, { roundOpts: { result_error: eperm }, over: { limit: { kind: 'resource_limit', evidence: eperm } } })).errors, []);
});

test('[rr1-8] probe classifier is carrier-specific: a Claude relay uses sessionId, readOnly and subscription auth', () => {
  const obs = { carrier: 'claude', relay_present: true, cli_version: { status: 0 }, login: { status: 0, authMethod: 'claude.ai' }, nonce: 'n1',
    dispatch: { result: { status: 'completed', sessionId: 's-1', readOnly: true, finalMessage: 'probe-ok n1' } }, resume: { result: { status: 'completed', sessionId: 's-1', readOnly: true } },
    cancel: { child_seen: true, result: { status: 'timeout' }, survivors: [] }, coverage: { before: 'c', after: 'c', ignored_before: 'i', ignored_after: 'i' } };
  for (const [k, v] of Object.entries(B.classifyProbe(obs))) assert.equal(v.result, 'pass', k);
  assert.equal(B.classifyProbe({ ...obs, login: { status: 0, authMethod: 'api_key' } }).dispatch.class, 'auth');
  assert.equal(B.classifyProbe({ ...obs, dispatch: { result: { ...obs.dispatch.result, readOnly: false } } }).fresh_result.result, 'fail');
});

const FAKE_CLAUDE = (method) => `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.0.0 (Claude Code)"; exit 0; fi\nif [ "$1" = "auth" ]; then echo '{"loggedIn":true,"authMethod":"${method}"}'; exit 0; fi\nexit 2\n`;
test('[rr1-8] probe with a FAKE Claude relay (parser only): passes with subscription auth, auth class with an API key', { skip: POSIX_ONLY }, (t) => {
  for (const [method, want] of [['claude.ai', 'pass'], ['api_key', 'fail']]) {
    const f = probeFixture(t);
    writeFileSync(f.codex, FAKE_CLAUDE(method));
    const r = probe(f, 'ok', ['--carrier', 'claude'], { FAKE_CARRIER: 'claude' });
    const out = JSON.parse(r.stdout);
    assert.equal(out.carrier, 'claude');
    assert.equal(out.codex_route.dispatch.result, want, JSON.stringify(out.codex_route));
    if (want === 'pass') for (const v of Object.values(out.codex_route)) assert.equal(v.result, 'pass', JSON.stringify(out.codex_route));
  }
});

test('[rr1-9] a failed process listing is a cancellation failure, never a pass', { skip: POSIX_ONLY }, (t) => {
  assert.equal(B.classifyProbe({ relay_present: true, codex_version: { status: 0 }, login: { status: 0 }, nonce: 'n', dispatch: { result: { status: 'completed', threadId: 't', finalMessage: 'probe-ok n' } },
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

test('[rr1-12] an echo inside a code fence is not an echo; the narrative Result must match the attestation outcome', (t) => {
  const D = digestOf(withResult(narrative(), 'CONVERGED'));
  const fenced = '```\n' + echo({ request_id: 'req-final', plan_version: 'v2', plan_digest: D }) + '\n```';
  assert.ok(codes(pre(converged(t, { r2: { message: fenced } }))).includes('debate_echo_invalid'));
  const mismatch = converged(t, { narr: withResult(narrative(), 'UNRESOLVED'), over: {} });
  assert.ok(codes(pre(mismatch)).includes('debate_outcome_invalid'), 'Result: UNRESOLVED over a CONVERGED attestation');
});
