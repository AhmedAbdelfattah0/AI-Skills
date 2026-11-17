/**
 * lib/durable-io.mjs: the atomic state write and the engine lock (S-30a), including the opt-in
 * bounded wait and AbortSignal cancellation.
 *
 * Cases ported from deepseek-harness@39163dd30f703a79079e2d2446545cff3c453738
 * packages/util/atomic-write/tests/atomic-write.spec.ts (MIT, Copyright (c) 2026 DeepSeek; the
 * licence text is in lib/durable-io.mjs). Each ported test names its source in an `// upstream:`
 * line. They test OUR implementation; no upstream code runs here. All 36 expanded upstream cases:
 *
 * | #  | upstream line: case                                              | class       | why / how |
 * |----|------------------------------------------------------------------|-------------|-----------|
 * | 1  | :125 preserves non-UTF-8 binary content                          | adapted     | JSON-only payload: non-ASCII, astral, NUL and lone-surrogate text round-trips byte-exactly |
 * | 2  | :132 creates file and parents with the stated mode               | adapted     | mode is fixed 0o600; no dirMode option (parents get the mkdir default) |
 * | 3  | :143 replaces and narrows a wider-permission file                | applicable  | |
 * | 4  | :152 replaces a symlinked target, not its referent               | applicable  | POSIX only here (symlink creation needs a privilege on Windows) |
 * | 5  | :164 retries transient win32 rename codes, then commits          | adapted     | injected fs.renameSync and platform; EACCES joins EPERM/EBUSY (S-30a) |
 * | 6  | :182 no temp sibling after bounded win32 retries expire          | adapted     | our bound is 10 attempts (upstream 9) |
 * | 7  | :200 no win32 retry for a failure without a code                 | applicable  | |
 * | 8  | :211 no rename retry outside win32                               | applicable  | |
 * | 9  | :223 cancels a waiting writer without releasing the holder       | adapted     | handle API; abort rejects with signal.reason (AbortError) |
 * | 10 | :243 retries EPERM only when the lock path exists                | unsupported | no fault seam on the lock's exclusive create; win32 EPERM is retried while waiting |
 * | 11 | :260 persistent EPERM on win32 when no lock exists               | unsupported | same |
 * | 12 | :260 persistent EPERM on linux when no lock exists               | unsupported | same |
 * | 13 | :270 win32 holder releases before the contention probe           | unsupported | same |
 * | 14 | :284 rejects an invalid parent hierarchy                         | applicable  | |
 * | 15 | :296 takes over a lock whose holder exited                       | adapted     | injected processInfo instead of a process.kill spy |
 * | 16 | :308 takes over the lock of a process that really exited         | applicable  | POSIX only, as upstream |
 * | 17 | :318 one contender at a time over the same exited holder         | adapted     | 8 in-process contenders with waitMs |
 * | 18 | :336 waits for the lock of a live holder                         | applicable  | |
 * | 19 | :336 waits for the lock of this process                          | applicable  | |
 * | 20 | :336 waits for an empty record                                   | adapted     | waits, then rethrows lock_malformed (not a timeout) |
 * | 21 | :336 waits for an incomplete record                              | adapted     | same |
 * | 22 | :336 waits for a record that is not a PID                        | adapted     | same |
 * | 23 | :336 waits for a record naming a process group (pid 0)           | adapted     | JSON record; POSIX only (kill(0, 0) probes the own group) |
 * | 24 | :336 waits for a record beyond the int32 range                   | DIVERGES    | ours probes it as dead and RECOVERS the lock; ported as a todo, see UNRESOLVED |
 * | 25 | :336 waits for a record beyond the safe integer range            | adapted     | raw text: lock_malformed |
 * | 26 | :360 waits for a holder under another user (probe EPERM)         | adapted     | process.kill mocked under the real processInfo |
 * | 27 | :373 keeps its own lock when the runtime cannot probe itself     | unsupported | browser-worker shim; our processInfo is the only probe |
 * | 28 | :387 keeps a lock whose holder reused the PID during the claim   | adapted     | rewritten at the lock-stale-observed boundary; the nonce re-check refuses |
 * | 29 | :403 waits when the exited holder's lock cannot be removed       | unsupported | no fault seam on the lock unlink |
 * | 30 | :415 waits for a lock it cannot read                             | adapted     | a directory lock fails closed at once (EISDIR), not waited |
 * | 31 | :423 leaves an exited holder's lock to the claim's owner         | adapted     | our claim is the `.recovery` marker |
 * | 32 | :436 keeps a lock another contender took during the claim        | adapted     | successor written at the lock-stale-observed boundary |
 * | 33 | :452 retries after a claim is refused                            | adapted     | marker refused (EEXIST), then cleared: the wait acquires |
 * | 34 | :463 surfaces a claim failure that is not contention             | unsupported | no fault seam on the marker create |
 * | 35 | :475 runs when its claim cannot be removed afterwards            | unsupported | no fault seam on the marker unlink (it is swallowed) |
 * | 36 | :485 waits for the caller-stated limit                           | adapted     | there is no default wait: no waitMs is one attempt (AC1) |
 *
 * Totals: 8 applicable, 19 adapted, 8 unsupported, 1 divergent (todo).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { getEventListeners, once } from 'node:events';
import { hostname, tmpdir } from 'node:os';
import { fsyncSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync,
  writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { acquireLock, writeStateAtomic } from './durable-io.mjs';
import { processInfo } from '../engine-quiesce.mjs';

const WIN = process.platform === 'win32';
const POSIX_ONLY = WIN ? 'POSIX only' : false;
/** A PID no process has (upstream's EXITED_PID): the probe reports it absent. */
const EXITED_PID = 2_000_000_000;
const HOST = hostname();

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'durable-io-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10 }));
  return dir;
}
/** Await `p`, turning a rejection into an assertion failure (so a refused acquire or write fails as an assertion). */
async function must(p) {
  const r = await p.then((v) => ({ v }), (e) => ({ e }));
  assert.equal(r.e, undefined, `expected success, got ${r.e?.code ?? r.e}`);
  return r.v;
}
const tmpSiblings = (dir) => readdirSync(dir).filter(e => e.endsWith('.tmp'));
const ctxIn = (dir, extra = {}) => ({ lockFile: join(dir, 'document.lock'), runId: 'r', ...extra });
const record = (pid, extra = {}) => JSON.stringify({ pid, process_start_time: null, host: HOST, run_id: 'other', nonce: 'held', ...extra });
/** processInfo with `dead` pids reported gone and every other pid probed for real. */
const deadFor = (...dead) => (pid) => (dead.includes(pid) ? { alive: false, startTime: null } : processInfo(pid));
/** fs.renameSync failing with `codes` in turn ('NO_CODE': an error without a code), then renaming; counts attempts. */
function flakyRename(codes, real) {
  const fs = { attempts: 0, renameSync: (a, b) => {
    fs.attempts++;
    const code = codes.shift();
    if (code === 'NO_CODE') throw new Error('injected rename failure without a code');
    if (code) throw Object.assign(new Error(`${code}: injected`), { code });
    return real(a, b);
  } };
  return fs;
}

// ---------------------------------------------------------------- writeStateAtomic

test('W1 non-ASCII, astral, NUL and lone-surrogate state round-trips byte-exactly', async (t) => {
  // upstream: atomic-write.spec.ts:125 preserves non-UTF-8 binary content during atomic replacement
  const file = join(scratch(t), 'state.json');
  const state = { s: 'é\u0000\u{1F600}\uDC00', n: [0, 255, 128] };
  await writeStateAtomic(file, state);
  assert.deepEqual(readFileSync(file), Buffer.from(JSON.stringify(state, null, 1) + '\n'));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), state);
});

test('W2 creates missing parents and an owner-only file', async (t) => {
  // upstream: atomic-write.spec.ts:132 creates the file and its parents with exactly the stated mode
  const file = join(scratch(t), 'nested', 'deep', 'state.json');
  await writeStateAtomic(file, { a: 1 });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { a: 1 });
  if (!WIN) assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('W3 replaces existing content and narrows a wider-permission file to 0o600', async (t) => {
  // upstream: atomic-write.spec.ts:143 replaces existing content and narrows a wider-permission file to the stated mode
  const file = join(scratch(t), 'state.json');
  writeFileSync(file, 'old', { mode: 0o644 });
  await writeStateAtomic(file, { v: 'new' });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { v: 'new' });
  if (!WIN) assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('W4 replaces a symlinked target itself without writing through to the referent', { skip: POSIX_ONLY }, async (t) => {
  // upstream: atomic-write.spec.ts:152 replaces a symlinked target itself without writing through to the referent
  const dir = scratch(t);
  const victim = join(dir, 'victim'), file = join(dir, 'state.json');
  writeFileSync(victim, 'victim-content');
  symlinkSync(victim, file);
  await writeStateAtomic(file, { v: 'replaced' });
  assert.equal(lstatSync(file).isSymbolicLink(), false);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { v: 'replaced' });
  assert.equal(readFileSync(victim, 'utf8'), 'victim-content');
});

test('W5 win32 retries transient EACCES, EBUSY and EPERM renames and commits', async (t) => {
  // upstream: atomic-write.spec.ts:164 retries transient Windows rename interference and commits the replacement
  const dir = scratch(t), file = join(dir, 'state.json');
  writeFileSync(file, 'old');
  const fs = flakyRename(['EACCES', 'EBUSY', 'EPERM'], renameSync);
  await must(writeStateAtomic(file, { v: 'new' }, { platform: 'win32', fs }));
  assert.equal(fs.attempts, 4);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { v: 'new' });
  assert.deepEqual(tmpSiblings(dir), []);
});

test('W6 win32 leaves the old state and no temp sibling after 10 refused renames', async (t) => {
  // upstream: atomic-write.spec.ts:182 leaves no temp sibling after bounded Windows rename retries expire
  const dir = scratch(t), file = join(dir, 'state.json');
  writeFileSync(file, 'old');
  const fs = flakyRename(Array(12).fill('EACCES'), renameSync);
  await assert.rejects(writeStateAtomic(file, { v: 'new' }, { platform: 'win32', fs }), { code: 'EACCES' });
  assert.equal(fs.attempts, 10);
  assert.equal(readFileSync(file, 'utf8'), 'old');
  assert.deepEqual(tmpSiblings(dir), []);
});

test('W7 win32 does not retry a rename failure without a transient code', async (t) => {
  // upstream: atomic-write.spec.ts:200 does not retry a Windows rename failure without a transient code
  const dir = scratch(t), file = join(dir, 'state.json');
  const fs = flakyRename(['NO_CODE'], renameSync);
  await assert.rejects(writeStateAtomic(file, { v: 1 }, { platform: 'win32', fs }), /without a code/);
  assert.equal(fs.attempts, 1);
  assert.deepEqual(tmpSiblings(dir), []);
});

test('W8 no rename retry outside win32, EACCES included', async (t) => {
  // upstream: atomic-write.spec.ts:211 does not retry rename permission failures outside Windows
  const dir = scratch(t), file = join(dir, 'state.json');
  for (const code of ['EPERM', 'EACCES']) {
    const fs = flakyRename([code], renameSync);
    await assert.rejects(writeStateAtomic(file, { v: 1 }, { platform: 'linux', fs }), { code });
    assert.equal(fs.attempts, 1);
  }
  assert.deepEqual(tmpSiblings(dir), []);
});

test('AC4 the temp file is fsynced before the rename and the directory after it', { skip: POSIX_ONLY }, async (t) => {
  const file = join(scratch(t), 'state.json');
  const seen = [];
  const fs = { fsyncSync: (fd) => { seen.push('fsync'); fsyncSync(fd); } };
  await writeStateAtomic(file, { v: 1 }, { fs, hooks: { boundary: (n) => { seen.push(n); } } });
  assert.deepEqual(seen, ['temp-write', 'temp-fsync', 'fsync', 'rename', 'dir-fsync', 'fsync']);
});

// ---------------------------------------------------------------- acquireLock
// Waiting is driven through the `now` and `sleep` seams: a fake monotonic clock that a fake sleep
// advances by exactly the requested time. No assertion here depends on how fast the runner is.

/** Fake time. `onSleep(count, ms)` runs inside each sleep (to release a holder, abort, ...). */
function fakeTime(onSleep = () => {}) {
  let t = 1000;
  const slept = [];
  return { slept, now: () => t, sleep: async (ms, signal) => { slept.push(ms); t += ms; await onSleep(slept.length, ms); signal?.throwIfAborted(); } };
}
/** A clock that never reaches the deadline, with a real macrotask yield per sleep (in-process contention). */
const endless = { waitMs: 1, now: () => 0, sleep: () => new Promise(r => setImmediate(r)) };
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

test('AC1 without waitMs a live holder is refused at once with lock_held, never sleeping', async (t) => {
  const dir = scratch(t);
  const holder = await must(acquireLock(ctxIn(dir)));
  t.after(() => holder.release());
  const ft = fakeTime();
  await assert.rejects(acquireLock(ctxIn(dir)), { code: 'lock_held' });
  await assert.rejects(acquireLock(ctxIn(dir), { now: ft.now, sleep: ft.sleep }), { code: 'lock_held' });
  assert.deepEqual(ft.slept, []);
});

test('AC2 waitMs bounds the wait for a live holder with lock_timeout; a patient waiter acquires on release', async (t) => {
  // upstream: atomic-write.spec.ts:485 waits for the caller-stated limit rather than the protocol default
  const dir = scratch(t);
  const holder = await must(acquireLock(ctxIn(dir)));
  const held = readFileSync(holder.lockFile, 'utf8');
  const ft = fakeTime();
  await assert.rejects(acquireLock(ctxIn(dir), { waitMs: 150, now: ft.now, sleep: ft.sleep }), { code: 'lock_timeout' });
  assert.deepEqual(ft.slept, [20, 40, 80, 10]);
  assert.equal(readFileSync(holder.lockFile, 'utf8'), held);
  const patient = fakeTime(async (n) => { if (n === 1) await holder.release(); });
  const got = await must(acquireLock(ctxIn(dir), { waitMs: 10_000, now: patient.now, sleep: patient.sleep }));
  assert.deepEqual(patient.slept, [20]);
  assert.equal(JSON.parse(readFileSync(got.lockFile, 'utf8')).run_id, 'r');
  await got.release();
});

test('AC2 back-off doubles to 200 ms and the last sleep is clamped to the deadline', async (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, 'document.lock'), record(4242));
  const ft = fakeTime();
  await assert.rejects(acquireLock(ctxIn(dir, { processInfo: () => ({ alive: true, startTime: null }) }), { waitMs: 710, now: ft.now, sleep: ft.sleep }), { code: 'lock_timeout' });
  assert.deepEqual(ft.slept, [20, 40, 80, 160, 200, 200, 10]);
  assert.equal(sum(ft.slept), 710);
});

test('AC2 the deadline is monotonic: wall-clock jumps neither extend nor cut the wait', async (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, 'document.lock'), record(4242));
  const ctx = ctxIn(dir, { processInfo: () => ({ alive: true, startTime: null }) });
  let calls = 0;
  t.mock.method(Date, 'now', () => (calls++ % 2 ? 0 : 4_000_000_000_000)); // back to 1970, forward to 2096, in turn
  const ft = fakeTime();
  await assert.rejects(acquireLock(ctx, { waitMs: 150, now: ft.now, sleep: ft.sleep }), { code: 'lock_timeout' });
  assert.deepEqual(ft.slept, [20, 40, 80, 10]);
  // The default clock too: the wall clock jumps forward a century during the first sleep, and the
  // wait still lasts waitMs on the monotonic clock (a lower bound, so no scheduling allowance).
  let jumped = false;
  t.mock.method(Date, 'now', () => (jumped ? 4_000_000_000_000 : 0));
  const t0 = performance.now();
  await assert.rejects(acquireLock(ctx, { waitMs: 300, sleep: async (ms) => { jumped = true; await new Promise(r => setTimeout(r, ms)); } }), { code: 'lock_timeout' });
  assert.ok(performance.now() - t0 >= 300, `waited ${Math.round(performance.now() - t0)} ms of 300`);
});

test('AC3 every back-off sleep listens to the signal, so an abort interrupts it', async (t) => {
  // Real sleeps. With an injected probe an attempt never yields to the timer queue, so a timer
  // callback always observes the waiter inside a sleep; `now` never reaches the deadline.
  const dir = scratch(t);
  writeFileSync(join(dir, 'document.lock'), record(4242));
  const controller = new AbortController();
  const waiter = acquireLock(ctxIn(dir, { processInfo: () => ({ alive: true, startTime: null }) }), { waitMs: 1, now: () => 0, signal: controller.signal });
  for (const ms of [10, 90, 250]) {
    await new Promise(r => setTimeout(r, ms));
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1, `listening after ${ms} ms`);
  }
  controller.abort();
  await assert.rejects(waiter, { name: 'AbortError' });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('AC3 an already-aborted signal creates nothing even when the lock is free', async (t) => {
  const dir = scratch(t);
  const signal = AbortSignal.abort();
  await assert.rejects(acquireLock(ctxIn(dir), { waitMs: 1000, signal }), { name: 'AbortError' });
  await assert.rejects(acquireLock(ctxIn(dir), { signal }), { name: 'AbortError' });
  assert.deepEqual(readdirSync(dir), []);
});

test('AC2 waitMs must be a finite number >= 0', async (t) => {
  const dir = scratch(t);
  for (const waitMs of [-1, Infinity, NaN, '50']) await assert.rejects(acquireLock(ctxIn(dir), { waitMs }), TypeError);
});

test('AC3 an abort while waiting rejects with the reason, keeps the holder and leaves no claim', async (t) => {
  // upstream: atomic-write.spec.ts:223 cancels a waiting writer without releasing the current holder
  const dir = scratch(t);
  const holder = await must(acquireLock(ctxIn(dir)));
  const held = readFileSync(holder.lockFile, 'utf8');
  const controller = new AbortController();
  const ft = fakeTime((n) => { if (n === 2) controller.abort(); });
  await assert.rejects(acquireLock(ctxIn(dir), { waitMs: 10_000, signal: controller.signal, now: ft.now, sleep: ft.sleep }), { name: 'AbortError' });
  assert.equal(ft.slept.length, 2);
  assert.equal(readFileSync(holder.lockFile, 'utf8'), held);
  assert.deepEqual(readdirSync(dir), ['document.lock']);
  // An already-aborted signal refuses before any attempt, with or without waitMs.
  await assert.rejects(acquireLock(ctxIn(dir), { waitMs: 10_000, signal: controller.signal }), { name: 'AbortError' });
  await holder.release();
  await assert.rejects(acquireLock(ctxIn(dir), { signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(readdirSync(dir), []);
});

for (const waitMs of [undefined, 1000]) {
  test(`AC3 an abort inside the lock-stale-observed hook takes no lock and leaves no marker (waitMs ${waitMs})`, async (t) => {
    const dir = scratch(t), lockFile = join(dir, 'document.lock');
    const stale = record(EXITED_PID);
    writeFileSync(lockFile, stale);
    const controller = new AbortController(), reason = new Error('cancelled at the hook');
    const hooks = { boundary: (name) => { if (name === 'lock-stale-observed') controller.abort(reason); } };
    const ft = fakeTime();
    const got = acquireLock(ctxIn(dir, { processInfo: deadFor(EXITED_PID), hooks }), { waitMs, signal: controller.signal, now: ft.now, sleep: ft.sleep });
    await assert.rejects(got, (e) => e === reason);
    assert.equal(readFileSync(lockFile, 'utf8'), stale);
    assert.deepEqual(readdirSync(dir), ['document.lock']);
    assert.deepEqual(ft.slept, []);
  });
}

test('L14 rejects an invalid parent hierarchy without creating a lock', async (t) => {
  // upstream: atomic-write.spec.ts:284 rejects an invalid parent hierarchy before running the operation
  const parent = join(scratch(t), 'not-a-directory');
  writeFileSync(parent, 'occupied');
  await assert.rejects(acquireLock({ lockFile: join(parent, 'document.lock'), runId: 'r' }, { waitMs: 50 }), { code: /ENOTDIR|EEXIST|ENOENT/ });
});

test('L15 takes over a lock whose holder exited, leaving no marker', async (t) => {
  // upstream: atomic-write.spec.ts:296 takes over a lock whose holder exited
  const dir = scratch(t);
  writeFileSync(join(dir, 'document.lock'), record(EXITED_PID));
  const got = await must(acquireLock(ctxIn(dir, { processInfo: deadFor(EXITED_PID) }), { waitMs: 0 }));
  assert.equal(JSON.parse(readFileSync(got.lockFile, 'utf8')).pid, process.pid);
  assert.deepEqual(readdirSync(dir), ['document.lock']);
  await got.release();
});

test('L16 takes over the lock of a process that really exited', { skip: POSIX_ONLY }, async (t) => {
  // upstream: atomic-write.spec.ts:308 takes over the lock of a process that really exited
  const dir = scratch(t);
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(child, 'exit');
  writeFileSync(join(dir, 'document.lock'), record(child.pid));
  const got = await must(acquireLock(ctxIn(dir), { waitMs: 0 }));
  assert.equal(JSON.parse(readFileSync(got.lockFile, 'utf8')).pid, process.pid);
  await got.release();
});

test('L17 admits one contender at a time when several take over the same exited holder', async (t) => {
  // upstream: atomic-write.spec.ts:318 admits one contender at a time when several take over the same exited holder
  const dir = scratch(t);
  writeFileSync(join(dir, 'document.lock'), record(EXITED_PID));
  let active = 0, overlapped = false;
  await Promise.all(Array.from({ length: 8 }, async () => {
    const h = await must(acquireLock(ctxIn(dir, { processInfo: deadFor(EXITED_PID) }), endless));
    active++; overlapped ||= active > 1;
    await new Promise(r => setTimeout(r, 5));
    active--;
    await h.release();
  }));
  assert.equal(overlapped, false);
  assert.deepEqual(readdirSync(dir), []);
});

for (const [n, label, render, code, skip] of [
  [18, 'a live holder', () => record(process.ppid, { process_start_time: processInfo(process.ppid).startTime }), 'lock_timeout'],
  [19, 'this process', () => record(process.pid, { process_start_time: processInfo(process.pid).startTime }), 'lock_timeout'],
  [20, 'an empty record', () => '', 'lock_malformed'],
  [21, 'an incomplete record', () => '12', 'lock_malformed'],
  [22, 'a record that is not a PID', () => 'holder\n', 'lock_malformed'],
  [23, 'a record naming a process group', () => record(0), 'lock_timeout', POSIX_ONLY],
  [25, 'a record beyond the safe integer range', () => '99999999999999999999\n', 'lock_malformed'],
]) {
  test(`L${n} waits for the lock of ${label}, then ${code}`, { skip }, async (t) => {
    // upstream: atomic-write.spec.ts:336 waits for the lock of %s
    const dir = scratch(t), lockFile = join(dir, 'document.lock');
    const held = render();
    writeFileSync(lockFile, held);
    const ft = fakeTime();
    await assert.rejects(acquireLock(ctxIn(dir), { waitMs: 80, now: ft.now, sleep: ft.sleep }), { code });
    assert.equal(sum(ft.slept), 80, 'it waited the whole limit');
    assert.equal(readFileSync(lockFile, 'utf8'), held);
    assert.deepEqual(readdirSync(dir), ['document.lock']);
  });
}

test('L24 waits for a record beyond the int32 range', { todo: 'DIVERGES: processInfo reports an out-of-range pid as dead, so the lock is recovered (UNRESOLVED, S-30a report)' }, async (t) => {
  // upstream: atomic-write.spec.ts:336 waits for the lock of a record beyond the int32 range
  const dir = scratch(t), lockFile = join(dir, 'document.lock');
  writeFileSync(lockFile, record(2_147_483_648));
  const ft = fakeTime();
  const got = await acquireLock(ctxIn(dir), { waitMs: 50, now: ft.now, sleep: ft.sleep }).catch(e => e);
  if (got.release) await got.release();
  assert.equal(got.code, 'lock_timeout');
});

test('L26 waits for a holder whose process exists under another user', async (t) => {
  // upstream: atomic-write.spec.ts:360 waits for a holder whose process exists under another user
  const dir = scratch(t), lockFile = join(dir, 'document.lock');
  writeFileSync(lockFile, record(EXITED_PID, { process_start_time: 'Mon Jan  1 00:00:00 1990' }));
  const kill = process.kill.bind(process);
  t.mock.method(process, 'kill', (pid, sig) => {
    if (pid === EXITED_PID) throw Object.assign(new Error('EPERM: injected'), { code: 'EPERM' });
    return kill(pid, sig);
  });
  const ft = fakeTime();
  await assert.rejects(acquireLock(ctxIn(dir), { waitMs: 50, now: ft.now, sleep: ft.sleep }), { code: 'lock_timeout' });
  assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).nonce, 'held');
});

test('L28 keeps a lock whose holder reused the exited PID while this contender claimed it', async (t) => {
  // upstream: atomic-write.spec.ts:387 keeps a lock whose holder reused the exited PID while this contender claimed it
  const dir = scratch(t), lockFile = join(dir, 'document.lock');
  writeFileSync(lockFile, record(EXITED_PID));
  let probes = 0;
  const info = (pid) => (pid === EXITED_PID ? { alive: probes++ !== 0, startTime: null } : processInfo(pid));
  const reacquired = record(EXITED_PID, { nonce: 'reused' });
  const hooks = { boundary: (name) => { if (name === 'lock-stale-observed') { unlinkSync(lockFile); writeFileSync(lockFile, reacquired); } } };
  const ft = fakeTime();
  await assert.rejects(acquireLock(ctxIn(dir, { processInfo: info, hooks }), { waitMs: 50, now: ft.now, sleep: ft.sleep }), { code: 'lock_timeout' });
  assert.equal(readFileSync(lockFile, 'utf8'), reacquired);
  assert.deepEqual(readdirSync(dir), ['document.lock']);
});

test('L30 a lock that is a directory fails closed at once, without waiting', async (t) => {
  // upstream: atomic-write.spec.ts:415 waits for a lock it cannot read
  const dir = scratch(t), lockFile = join(dir, 'document.lock');
  mkdirSync(lockFile);
  const ft = fakeTime();
  await assert.rejects(acquireLock(ctxIn(dir), { waitMs: 3000, now: ft.now, sleep: ft.sleep }), WIN ? Error : { code: 'EISDIR' });
  if (!WIN) assert.deepEqual(ft.slept, []);
  assert.ok(statSync(lockFile).isDirectory());
  assert.deepEqual(readdirSync(dir), ['document.lock']);
});

test('L31 leaves an exited holder\'s lock to the contender holding the recovery marker', async (t) => {
  // upstream: atomic-write.spec.ts:423 leaves an exited holder's lock to the contender that claimed its record
  const dir = scratch(t), lockFile = join(dir, 'document.lock');
  const held = record(EXITED_PID);
  writeFileSync(lockFile, held);
  writeFileSync(lockFile + '.recovery', '{"pid":1,"nonce":"theirs"}');
  const ft = fakeTime();
  await assert.rejects(acquireLock(ctxIn(dir, { processInfo: deadFor(EXITED_PID) }), { waitMs: 50, now: ft.now, sleep: ft.sleep }), { code: 'lock_timeout' });
  assert.equal(readFileSync(lockFile, 'utf8'), held);
  assert.equal(readFileSync(lockFile + '.recovery', 'utf8'), '{"pid":1,"nonce":"theirs"}');
});

test('L32 keeps a lock that another contender acquired while this one claimed the exited record', async (t) => {
  // upstream: atomic-write.spec.ts:436 keeps a lock that another contender acquired while this one claimed the exited record
  const dir = scratch(t), lockFile = join(dir, 'document.lock');
  writeFileSync(lockFile, record(EXITED_PID));
  const successor = record(process.pid, { process_start_time: processInfo(process.pid).startTime, nonce: 'successor' });
  const hooks = { boundary: (name) => { if (name === 'lock-stale-observed') writeFileSync(lockFile, successor); } };
  const ft = fakeTime();
  await assert.rejects(acquireLock(ctxIn(dir, { processInfo: deadFor(EXITED_PID), hooks }), { waitMs: 50, now: ft.now, sleep: ft.sleep }), { code: 'lock_timeout' });
  assert.equal(readFileSync(lockFile, 'utf8'), successor);
  assert.deepEqual(readdirSync(dir), ['document.lock']);
});

test('L33 retries after the recovery marker is refused, then acquires once it clears', async (t) => {
  // upstream: atomic-write.spec.ts:452 retries after a claim is refused with EPERM
  const dir = scratch(t), lockFile = join(dir, 'document.lock');
  writeFileSync(lockFile, record(EXITED_PID));
  writeFileSync(lockFile + '.recovery', '{}');
  const ft = fakeTime((n) => { if (n === 2) unlinkSync(lockFile + '.recovery'); });
  const got = await must(acquireLock(ctxIn(dir, { processInfo: deadFor(EXITED_PID) }), { waitMs: 10_000, now: ft.now, sleep: ft.sleep }));
  assert.equal(ft.slept.length, 2);
  assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).pid, process.pid);
  await got.release();
});

// ---------------------------------------------------------------- regressions from the spike (Z)

test('AC4 / Z S1d a live PID with a different recorded start time is recovered (reuse); the same start time is held', async (t) => {
  const dir = scratch(t), lockFile = join(dir, 'document.lock');
  const live = process.ppid, start = processInfo(live).startTime;
  writeFileSync(lockFile, record(live, { process_start_time: 'Mon Jan  1 00:00:00 1990' }));
  if (WIN) {
    // processInfo reports startTime null on win32: no reuse proof, so a live PID is always the holder.
    await assert.rejects(acquireLock(ctxIn(dir)), { code: 'lock_held' });
    return;
  }
  const got = await must(acquireLock(ctxIn(dir)));
  assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).pid, process.pid);
  await got.release();
  writeFileSync(lockFile, record(live, { process_start_time: start }));
  await assert.rejects(acquireLock(ctxIn(dir)), { code: 'lock_held' });
  // Injected identity, any platform: the decision is the start-time comparison.
  const info = (pid) => (pid === 4242 ? { alive: true, startTime: 'T1' } : { alive: true, startTime: 'me' });
  writeFileSync(lockFile, record(4242, { process_start_time: 'T0' }));
  const reused = await must(acquireLock(ctxIn(dir, { pid: 1, processInfo: info })));
  await reused.release();
});

/**
 * Child `id`: increment a JSON counter `n` times. Every child first announces `ready-<id>` and waits
 * for `go`. Mode 'lock' takes the lock around each increment. Mode 'race' (the negative control)
 * takes none and forces the lost update: in each round every child reads, waits until all six have
 * read, writes, and waits until all six have written, so each round adds exactly 1.
 */
const WORKER = `
const [lib, dir, file, lockFile, n, mode, id] = process.argv.slice(1);
const { readFileSync, readdirSync, writeFileSync } = await import('node:fs');
const { join } = await import('node:path');
const { acquireLock, writeStateAtomic } = await import(lib);
const mark = (name) => writeFileSync(join(dir, name), '');
const until = async (ok) => { while (!ok()) await new Promise(r => setTimeout(r, 2)); };
const all = (prefix) => () => readdirSync(dir).filter(e => e.startsWith(prefix)).length === 6;
mark('ready-' + id);
await until(() => readdirSync(dir).includes('go'));
for (let i = 0; i < Number(n); i++) {
  const h = mode === 'lock' ? await acquireLock({ lockFile, runId: 'w' }, { waitMs: 60000 }) : null;
  const v = JSON.parse(readFileSync(file, 'utf8')).n;
  if (mode === 'race') { mark('r' + i + '-read-' + id); await until(all('r' + i + '-read-')); }
  await writeStateAtomic(file, { n: v + 1 });
  if (mode === 'race') { mark('r' + i + '-wrote-' + id); await until(all('r' + i + '-wrote-')); }
  await h?.release();
}`;

async function contend(t, mode) {
  const dir = scratch(t);
  const file = join(dir, 'counter.json'), lockFile = join(dir, 'counter.lock');
  await writeStateAtomic(file, { n: 0 });
  const lib = new URL('./durable-io.mjs', import.meta.url).href;
  const kids = Array.from({ length: 6 }, (_, id) => spawn(process.execPath, ['--input-type=module', '-e', WORKER, lib, dir, file, lockFile, '15', mode, String(id)], { stdio: ['ignore', 'ignore', 'pipe'] }));
  const errs = [];
  for (const k of kids) k.stderr.on('data', (d) => errs.push(String(d)));
  const exits = kids.map(k => once(k, 'exit').then(([c]) => c));
  while (readdirSync(dir).filter(e => e.startsWith('ready-')).length < 6) await new Promise(r => setTimeout(r, 5));
  writeFileSync(join(dir, 'go'), '');
  const codes = await Promise.all(exits);
  return { n: JSON.parse(readFileSync(file, 'utf8')).n, codes, errs: errs.join(''), left: readdirSync(dir).filter(e => e.startsWith('counter.lock')) };
}

test('AC6 / Z S1b 6 processes x 15 increments lose no update under the lock; without it, the forced interleaving loses 75', { skip: WIN ? 'POSIX only here: Windows delete-pending and rename semantics under this load are unverified (follow-up)' : false }, async (t) => {
  const locked = await contend(t, 'lock');
  assert.deepEqual(locked.codes, [0, 0, 0, 0, 0, 0], locked.errs);
  assert.equal(locked.n, 90);
  assert.deepEqual(locked.left, []);
  const bare = await contend(t, 'race');
  assert.deepEqual(bare.codes, [0, 0, 0, 0, 0, 0], bare.errs);
  assert.equal(bare.n, 15, 'the negative control loses exactly the 75 interleaved updates');
});
