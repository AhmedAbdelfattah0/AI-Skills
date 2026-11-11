import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkShipReady } from './ship-ready-check.mjs';

const CLI = fileURLToPath(new URL('./ship-ready-check.mjs', import.meta.url));
const plan = (events) => ['# Plan', '', '<!-- RUN-STATE:BEGIN -->', ...events.map((e) => JSON.stringify(e)), '<!-- RUN-STATE:END -->', ''].join('\n');
const log = (events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
const gate = (id, over = {}) => ({ run_id: 'r1', event: 'GATE', gate: 'ship-ready', ok: true, code: 'ship_ready', candidate_id: id, ...over });
const ready = (id) => ({ run_id: 'r1', event: 'SHIP_READY', event_id: 'ship-ready-' + id, candidate_id: id });

/** `requireAt`: where --require-event goes ('first' | 'last'); omitted, the flag is not passed. */
function cli(planText, logText, requireAt) {
  const dir = mkdtempSync(join(tmpdir(), 'srcheck-'));
  try {
    writeFileSync(join(dir, 'plan.md'), planText);
    writeFileSync(join(dir, 'engine.log'), logText);
    const flags = ['--run-state', join(dir, 'plan.md'), '--engine-log', join(dir, 'engine.log')];
    if (requireAt === 'first') flags.unshift('--require-event');
    if (requireAt === 'last') flags.push('--require-event');
    return spawnSync(process.execPath, [CLI, 'check', ...flags], { encoding: 'utf8' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('the engine-written pair passes', () => {
  const r = cli(plan([ready('sha256:aa')]), log([gate('sha256:aa')]));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 SHIP_READY matched/);
});

test('planted failure: a hand-written SHIP_READY with no engine line fails and names the candidate', () => {
  const r = cli(plan([ready('sha256:bb')]), log([]));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /sha256:bb/);
});

test('planted failure: wrong candidate, refused gate and other gates do not match', () => {
  for (const entries of [[gate('sha256:other')], [gate('sha256:cc', { ok: false })], [gate('sha256:cc', { gate: 'review' })]]) {
    const v = checkShipReady(plan([ready('sha256:cc')]), log(entries));
    assert.equal(v.ok, false);
    assert.deepEqual(v.unmatched, ['sha256:cc']);
  }
});

test('every unmatched candidate is listed; matched ones are not', () => {
  const v = checkShipReady(plan([ready('c1'), ready('c2'), ready('c3')]), log([gate('c2')]));
  assert.equal(v.ok, false);
  assert.deepEqual(v.unmatched, ['c1', 'c3']);
  assert.match(v.reason, /c1, c3/);
});

test('a SHIP_READY with no candidate id fails; no SHIP_READY passes; missing block fails', () => {
  assert.equal(checkShipReady(plan([{ event: 'SHIP_READY' }]), log([gate('c1')])).ok, false);
  assert.equal(checkShipReady(plan([{ event: 'START' }]), '').ok, true);
  assert.equal(checkShipReady('# no block', '').ok, false);
});

test('usage error exits 2', () => {
  assert.equal(spawnSync(process.execPath, [CLI, 'check'], { encoding: 'utf8' }).status, 2);
});

/** A plan whose RUN-STATE block holds the given raw lines verbatim. */
const rawPlan = (lines) => ['# Plan', '', '<!-- RUN-STATE:BEGIN -->', ...lines, '<!-- RUN-STATE:END -->', ''].join('\n');

test('planted failure: a truncated event line in RUN-STATE fails with a reason, even with zero SHIP_READY', () => {
  const truncated = '{"event":"SHIP_READY","candidate_id":';
  const v = checkShipReady(rawPlan([JSON.stringify({ event: 'START' }), truncated]), '');
  assert.equal(v.ok, false);
  assert.match(v.reason, /malformed RUN-STATE/);
  assert.match(v.reason, /not JSON/);
  const r = cli(rawPlan([truncated]), '');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /FAIL malformed RUN-STATE/);
});

test('planted failure: a malformed line is not masked by a matched SHIP_READY', () => {
  const v = checkShipReady(rawPlan([JSON.stringify(ready('c1')), '{"event":"SHIP_READY"']), log([gate('c1')]));
  assert.equal(v.ok, false);
  assert.match(v.reason, /malformed RUN-STATE/);
});

test('a block that lost its END marker is malformed', () => {
  const v = checkShipReady(['# Plan', '<!-- RUN-STATE:BEGIN -->', JSON.stringify(ready('c1'))].join('\n'), log([gate('c1')]));
  assert.equal(v.ok, false);
  assert.match(v.reason, /malformed RUN-STATE/);
});

test('--require-event: zero SHIP_READY fails only with the flag, in either position', () => {
  const none = plan([{ event: 'START' }]);
  assert.equal(cli(none, '').status, 0, 'default stays off');
  for (const pos of ['first', 'last']) {
    const r = cli(none, '', pos);
    assert.equal(r.status, 1, pos);
    assert.match(r.stderr, /no SHIP_READY event/, pos);
  }
  const ok = cli(plan([ready('c9')]), log([gate('c9')]), 'last');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /1 SHIP_READY matched/);
  assert.equal(checkShipReady(none, '', { requireEvent: true }).ok, false);
});

/** CLI with several engine logs and extra flags. */
function cliMulti(planText, logTexts, extra = []) {
  const dir = mkdtempSync(join(tmpdir(), 'srcheck-'));
  try {
    writeFileSync(join(dir, 'plan.md'), planText);
    const flags = ['--run-state', join(dir, 'plan.md')];
    logTexts.forEach((t, i) => { writeFileSync(join(dir, `e${i}.log`), t); flags.push('--engine-log', join(dir, `e${i}.log`)); });
    return spawnSync(process.execPath, [CLI, 'check', ...flags, ...extra], { encoding: 'utf8' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('cross-run: a SHIP_READY of run B does not match run A gate line with the same candidate', () => {
  const v = checkShipReady(plan([{ ...ready('c1'), run_id: 'rB' }]), log([gate('c1', { run_id: 'rA' })]));
  assert.equal(v.ok, false);
  assert.deepEqual(v.unmatched, ['c1']);
  assert.equal(checkShipReady(plan([{ ...ready('c1'), run_id: 'rA' }]), log([gate('c1', { run_id: 'rA' })])).ok, true);
});

test('a SHIP_READY without run_id is unmatched', () => {
  const { run_id, ...bare } = ready('c1');
  assert.equal(checkShipReady(plan([bare]), log([gate('c1')])).ok, false);
});

test('--run-id restricts the check to that run: an earlier run SHIP_READY is not checked', () => {
  const p = plan([{ ...ready('c0'), run_id: 'rOld' }, { ...ready('c1'), run_id: 'rNew' }]);
  const l = log([gate('c1', { run_id: 'rNew' })]);
  assert.equal(cliMulti(p, [l]).status, 1, 'without --run-id the old run fails');
  assert.equal(cliMulti(p, [l], ['--run-id', 'rNew']).status, 0);
  const miss = cliMulti(plan([{ ...ready('c0'), run_id: 'rOld' }]), [l], ['--run-id', 'rNew', '--require-event']);
  assert.equal(miss.status, 1);
  assert.match(miss.stderr, /no SHIP_READY event/);
  assert.equal(cliMulti(p, [l], ['--run-id', 'rNew', '--require-event']).status, 0);
});

test('--engine-log may repeat: a gate line in any file matches', () => {
  const p = plan([ready('c1'), ready('c2')]);
  const r = cliMulti(p, [log([gate('c1')]), log([gate('c2')])]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(cliMulti(p, [log([gate('c1')]), log([])]).status, 1);
});
