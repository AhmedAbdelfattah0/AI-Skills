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
 * | 23 | :336 waits for a record naming a process group (pid 0)           | adapted     | refused as lock_malformed (fail closed), not waited |
 * | 24 | :336 waits for a record beyond the int32 range                   | adapted     | refused as lock_malformed (fail closed; was recovered before S-30a) |
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
 * Totals: 8 applicable, 20 adapted, 8 unsupported. (Row 24 was "divergent" until 4e487d9 refused
 * out-of-range PIDs.) Rows 29, 34 and 35 stay unsupported: TEST_SEAM's read/unlink faults reach
 * only the cancellation release (I3), not the recovery unlink or the marker.
 *
 * POSIX-only assertions (skipped or weakened on win32): W4 (symlink), the 0o600 mode checks in W2
 * and W3, AC4 (directory fsync is skipped on win32), L16 (a real exited child), L30's EISDIR code
 * and empty-sleep check, AC4/S1d's reuse recovery (win32 has no start time: lock_held only) and
 * AC6/S1b (6 processes). The cancellation sweep and the I1-I4 tests are platform-neutral (injected
 * fs faults, no real timers, no signals), but have not been run on Windows.
 *
 * Guard mutants (S-30a, 2026-11-18). Each guard of lib/durable-io.mjs was removed or moved in a
 * scratch copy, and ONLY the "I1-I5 cancellation sweep" test was run (Node 22, macOS). All 20 were
 * killed by an AssertionError (ERR_ASSERTION, no crash, no timeout). The first violation each produced:
 *
 * | mutant                                                   | killing assertion (first violation)                                   |
 * |----------------------------------------------------------|-----------------------------------------------------------------------|
 * | I4 entry check removed                                   | I2/I4: an abort that came before the failure did not win over it      |
 * | I1 final check removed                                   | I1: resolved with a handle although the abort came at or before ...  |
 * | I1 check before the commit boundary (order swapped)      | I1: resolved with a handle although the abort came at or before ...  |
 * | I1 await between the commit boundary and the check       | I1: the success exit did not resolve the call in the same turn ...   |
 * | I1 await between the check and the return                | I1: the success exit did not resolve the call in the same turn ...   |
 * | I1 round-3 shape (inner guarded check, no final check)   | I1: resolved with a handle although the abort came at or before ...  |
 * | I1 `owned` never set (no release on cancel)              | rejected with the reason but the lock file is still present ...       |
 * | I2 post-hook check removed                               | step acquired ran after the abort                                     |
 * | I2 check before classification removed                   | step sleep ran after the abort                                        |
 * | I2 catch check moved below classification and deadline   | I2/I4: an abort that came before the failure did not win over it      |
 * | I2 check after a failed sleep removed                    | rejected with sleep interrupted, which is neither the reason nor ...  |
 * | I2 loop-top check removed                                | step acquired ran after the abort                                     |
 * | I2 reason wrapped in an Error                            | rejected with aborted, which is neither the reason nor ...            |
 * | I3 read failure swallowed                                | rejected with the reason but the lock file is still present ...       |
 * | I3 unlink failure swallowed                              | rejected with the reason but the lock file is still present ...       |
 * | I3 read ENOENT reported as a leak                        | I3: leak reported where no release fault was injected                 |
 * | I3 unlink ENOENT reported as a leak                      | I3: leak reported where no release fault was injected                 |
 * | I3 leak error without the reason                         | I3: the leak error does not carry the reason and the failure          |
 * | I3 leak error without leakedLock                         | I3: leakedLock does not describe the lock left on disk                |
 * | I3 nonce check removed (a successor's lock is released)  | rejected with the reason but the lock file is still present ...       |
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
import { acquireLock, renameRetrying, writeStateAtomic, TEST_SEAM } from './durable-io.mjs';
import { processInfo } from '../engine-quiesce.mjs';

const WIN = process.platform === 'win32';
/** Fail fast on any unhandled rejection in this process; the last test also asserts there was none. */
const UNHANDLED = [];
process.on('unhandledRejection', (e) => { UNHANDLED.push(e); process.exitCode = 1; });
const existsLock = (f) => { try { statSync(f); return true; } catch { return false; } };
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

test('writeStateAtomic order: the successful rename comes before the dir-fsync hook, with the win32 retries (and their waits) before it, never after', async (t) => {
  // Differential for the renameRetrying extraction: the same step order as the inline loop it replaced.
  for (const [platform, failures] of [['win32', ['EPERM', 'EBUSY']], ['linux', []]].filter(([p]) => !(WIN && p === 'linux'))) { // a directory cannot be fsynced on win32
    const file = join(scratch(t), 'state.json'), seen = [];
    const fs = { renameSync: (a, b) => { const code = failures.shift(); seen.push(code ? `rename:${code}` : 'rename:ok'); if (code) throw Object.assign(new Error(`${code}: injected`), { code }); renameSync(a, b); },
      fsyncSync: (fd) => { seen.push('fsync'); fsyncSync(fd); } };
    await writeStateAtomic(file, { v: 1 }, { platform, fs, hooks: { boundary: (n) => { seen.push(`hook:${n}`); } } });
    const rename = seen.indexOf('rename:ok');
    assert.ok(rename > seen.indexOf('hook:rename') && seen.indexOf('hook:dir-fsync') === rename + 1, `${platform}: ${seen.join(' ')}`);
    assert.equal(seen.filter((s) => s === 'hook:rename').length, 1, `${platform}: the rename hook fires once, not per retry`);
    assert.equal(seen.filter((s) => s.startsWith('rename:')).length, 1 + (platform === 'win32' ? 2 : 0), platform);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { v: 1 });
  }
});

test('renameRetrying: waits 10*attempt between win32 refusals through the wait seam (no real sleep), then gives up after 10 attempts', async () => {
  const waits = [];
  let calls = 0;
  await assert.rejects(renameRetrying('a', 'b', { platform: 'win32', wait: async (ms) => { waits.push(ms); }, rename: () => { calls++; throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); } }), { code: 'EBUSY' });
  assert.equal(calls, 10);
  assert.deepEqual(waits, [10, 20, 30, 40, 50, 60, 70, 80, 90]);
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
  const reason = new Error('stop while sleeping');
  controller.abort(reason);
  await assert.rejects(waiter, (e) => e === reason); // the timer's own AbortError is not the reason
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('AC3 an already-aborted signal makes no attempt: nothing created, no recovery started', async (t) => {
  const dir = scratch(t), lockFile = join(dir, 'document.lock');
  const signal = AbortSignal.abort();
  await assert.rejects(acquireLock(ctxIn(dir), { waitMs: 1000, signal }), { name: 'AbortError' });
  await assert.rejects(acquireLock(ctxIn(dir), { signal }), { name: 'AbortError' });
  assert.deepEqual(readdirSync(dir), []);
  // A stale holder would start a recovery (the hook fires first): an aborted call never gets there.
  writeFileSync(lockFile, record(EXITED_PID));
  const seen = [];
  const hooks = { boundary: (name) => { seen.push(name); } };
  for (const waitMs of [undefined, 1000]) {
    await assert.rejects(acquireLock(ctxIn(dir, { processInfo: deadFor(EXITED_PID), hooks }), { waitMs, signal }), { name: 'AbortError' });
  }
  assert.deepEqual(seen, []);
  assert.equal(readFileSync(lockFile, 'utf8'), record(EXITED_PID));
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
    assert.equal(existsLock(lockFile) ? readFileSync(lockFile, 'utf8') : 'removed', stale);
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
  [23, 'a record naming a process group', () => record(0), 'lock_malformed'],
  [24, 'a record beyond the int32 range', () => record(2_147_483_648), 'lock_malformed'],
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

test('M2 a record whose pid cannot be probed is refused, never recovered, waitMs or not', async (t) => {
  const dir = scratch(t), lockFile = join(dir, 'document.lock');
  for (const pid of [0, -1, -4242, 1.5, 2_147_483_648, 1e20]) {
    writeFileSync(lockFile, record(pid));
    await assert.rejects(acquireLock(ctxIn(dir, { processInfo: () => ({ alive: false, startTime: null }) })), { code: 'lock_malformed' }, `pid ${pid}`);
    assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).pid, pid);
  }
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
  // The contender holding the marker must be ALIVE on every platform: this test process. (pid 1 was used before S1; it is
  // alive on POSIX (init/launchd) but no process has pid 1 on Windows, where S1 then correctly proves the marker stale.)
  const theirs = JSON.stringify({ pid: process.pid, nonce: 'theirs' });
  writeFileSync(lockFile + '.recovery', theirs);
  const ft = fakeTime();
  await assert.rejects(acquireLock(ctxIn(dir, { processInfo: deadFor(EXITED_PID) }), { waitMs: 50, now: ft.now, sleep: ft.sleep }), { code: 'lock_timeout' });
  assert.equal(readFileSync(lockFile, 'utf8'), held);
  assert.equal(readFileSync(lockFile + '.recovery', 'utf8'), theirs);
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

// ---------------------------------------------------------------- cancellation invariant (every boundary)

const HOSTILE_REASONS = [
  ['null', () => null], ['undefined (Node substitutes an AbortError)', () => undefined], ['a string', () => 'stop'],
  ['an Error', () => new Error('stop')], ['{ code: lock_held }', () => ({ code: 'lock_held' })],
  ['{ code: lock_timeout }', () => ({ code: 'lock_timeout' })], ['a frozen object', () => Object.freeze({ code: 'lock_held', message: 'frozen' })],
];
const SCENARIOS = [
  ['a stale holder (recovery path)', (lockFile) => writeFileSync(lockFile, record(EXITED_PID))],
  ['a live holder (waiting path)', (lockFile) => writeFileSync(lockFile, record(4242))],
  ['a free lock (create path)', () => {}],
];

/**
 * One acquireLock call with a tick at every boundary it can reach: each processInfo probe, entry to
 * and after an await inside the lock-stale-observed hook, entry to and after each (fake) sleep.
 * At tick `abortAt` the signal is aborted with `reason()`, synchronously (`defer` 0) or after
 * `defer` microtasks (landing between the library's own awaits).
 */
async function cancelRun(dir, setup, waitMs, abortAt, defer, reason, at = null) {
  const lockFile = join(dir, 'document.lock');
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir);
  setup(lockFile);
  const before = existsLock(lockFile) ? readFileSync(lockFile, 'utf8') : null;
  const controller = new AbortController();
  let ticks = 0, t = 0, fired = false;
  const log = []; // added for I1/I2 (see the I1-I5 sweep below, which supersedes this one): abort, a1, commit, settled
  controller.signal.addEventListener('abort', () => { log.push('abort'); queueMicrotask(() => log.push('a1')); });
  const fire = () => { fired = true; controller.abort(reason()); };
  const tick = () => {
    if (++ticks !== abortAt) return;
    if (defer === 0) return fire();
    let p = Promise.resolve();
    for (let i = 1; i < defer; i++) p = p.then(() => {});
    p.then(fire);
  };
  const processInfoTicked = (pid) => { tick(); return pid === EXITED_PID ? { alive: false, startTime: null } : { alive: true, startTime: null }; };
  const hooks = { boundary: async () => { tick(); await Promise.resolve(); tick(); } };
  const sleep = async (ms) => { tick(); t += ms; await Promise.resolve(); tick(); };
  const outcome = await acquireLock(ctxIn(dir, { processInfo: processInfoTicked, hooks }), { waitMs, signal: controller.signal, now: () => t, sleep, [TEST_SEAM]: { step: (n) => { if (n === 'commit') log.push(n); } } })
    .then((handle) => { log.push('settled'); return { handle }; }, (error) => { log.push('settled'); return { error }; });
  // Let a deferred abort that has not fired yet fire now, so `fired` is final.
  for (let i = 0; i <= defer; i++) await Promise.resolve();
  const after = existsLock(lockFile) ? readFileSync(lockFile, 'utf8') : null;
  return { outcome, ticks, fired, log, signal: controller.signal, entries: readdirSync(dir), lockFile, unchanged: before === after, removed: after === null };
}

test('AC3 cancellation invariant: an abort at any boundary rejects with exactly signal.reason, owning nothing', async (t) => {
  const dir = scratch(t);
  const violations = [];
  let cases = 0;
  for (const [scenario, setup] of SCENARIOS) {
    for (const waitMs of [undefined, 1000]) {
      const base = await cancelRun(dir, setup, waitMs, 0, 0, () => null);
      if (base.outcome.handle) await base.outcome.handle.release();
      for (let abortAt = 1; abortAt <= base.ticks; abortAt++) {
        for (const defer of [0, 1, 2, 3, 5, 8]) {
          for (const [label, reason] of defer === 0 ? HOSTILE_REASONS : HOSTILE_REASONS.filter(([l]) => l === 'null' || l.includes('lock_held'))) {
            cases++;
            const r = await cancelRun(dir, setup, waitMs, abortAt, defer, reason);
            const where = `${scenario}, waitMs ${waitMs}, abort at tick ${abortAt}/${base.ticks} +${defer} microtasks, reason ${label}`;
            const ours = existsLock(r.lockFile) && JSON.parse(readFileSync(r.lockFile, 'utf8') || '{}').run_id === 'r';
            if (r.entries.some(e => e.endsWith('.recovery'))) violations.push(`${where}: recovery marker left`);
            if (r.outcome.error !== undefined || 'error' in r.outcome) {
              if (ours) violations.push(`${where}: rejected while owning the lock`);
              if (r.fired && !Object.is(r.outcome.error, r.signal.reason) && defer === 0) violations.push(`${where}: rejected with ${String(r.outcome.error?.code ?? r.outcome.error)}, not the signal's reason`);
              if (r.fired && defer === 0 && !r.unchanged) violations.push(`${where}: the lock file changed after the abort`);
              if (!r.unchanged && !r.removed) violations.push(`${where}: rejected and the lock file is neither as it was nor removed`);
              const beforeSettle = r.log.includes('a1') && r.log.indexOf('a1') < r.log.indexOf('settled');
              if (beforeSettle && !Object.is(r.outcome.error, r.signal.reason)) violations.push(`${where}: an abort before the rejection did not win (${String(r.outcome.error?.code ?? r.outcome.error)})`);
            } else {
              if (r.fired && defer === 0) violations.push(`${where}: resolved although aborted at a boundary inside the call`);
              if (r.fired && r.log.indexOf('abort') < r.log.indexOf('commit')) violations.push(`${where}: resolved although the abort came before the success exit`);
              if (!ours) violations.push(`${where}: resolved without owning the lock`);
              await r.outcome.handle.release();
            }
          }
        }
      }
    }
  }
  t.diagnostic(`cancellation cases: ${cases}`);
  assert.ok(cases > 300, `the sweep ran (${cases} cases)`);
  assert.deepEqual(violations, []);
});

test('AC3 an abort landing between the recovery\'s create and the call\'s return releases that handle', async (t) => {
  // Deferring the abort from the hook by 1, 2, 3, ... microtasks walks it through the recovery: some
  // deferral lands after cancelFirst() let the recovery create our lock but before the call returns.
  // That handle must be released and the call must reject with the reason (never resolve with it).
  const dir = scratch(t);
  const classes = [];
  for (let defer = 1; defer <= 12; defer++) {
    const reason = { code: 'lock_held', defer };
    const r = await cancelRun(dir, SCENARIOS[0][1], undefined, 3, defer, () => reason);
    if ('handle' in r.outcome) { classes.push('resolved'); await r.outcome.handle.release(); continue; }
    assert.ok(Object.is(r.outcome.error, reason), `+${defer}: rejected with exactly the reason`);
    classes.push(existsLock(r.lockFile) ? 'untouched' : 'released');
  }
  assert.ok(classes.includes('released'), `some deferral lands inside the window: ${classes.join(' ')}`);
});

test('AC3 a deferred abort that lands before the call settles still rejects with exactly signal.reason', async (t) => {
  // The microtask-deferred aborts above may land after the call resolved (then the caller owns the
  // handle). Here the wait never ends on its own (live holder, deadline never reached), so every
  // deferred abort lands inside the call and must win, whatever its reason.
  const dir = scratch(t);
  for (const [label, reason] of HOSTILE_REASONS) {
    for (const defer of [1, 2, 3, 5, 8]) {
      const r = await cancelRun(dir, SCENARIOS[1][1], 1e9, 6, defer, reason);
      assert.ok('error' in r.outcome, `${label} +${defer}: rejected`);
      assert.ok(Object.is(r.outcome.error, r.signal.reason), `${label} +${defer}: rejected with exactly the reason`);
      assert.deepEqual(r.entries, ['document.lock'], `${label} +${defer}: nothing owned or left`);
    }
  }
});

// ---------------------------------------------------------------- cancellation invariants I1-I5 (generic sweep)

/**
 * The invariant sweep drives acquireLock through the test seam (TEST_SEAM): `step(name)` is called
 * synchronously at every named point (enter, attempt, acquired, hook, hooked, sleep, slept, commit).
 * Each run aborts the signal at step `at` (0: before the call, a pre-aborted signal), either
 * synchronously (`defer` 0) or after `defer` microtasks, which walks the abort across every await
 * and microtask boundary between two steps, including the continuation after the last await.
 * Everything is in-process and microtask-driven: fake clock, fake sleep, async hook. No timer.
 *
 * Scenarios: a free lock, a stale holder (recovery), a live holder that releases during the second
 * sleep (deferred successful returns), the same with a sleep that rejects with its own error on an
 * abort (as the real timer does), release faults (unlink or read of our lock fails once during the
 * cancellation release), and setup errors (bad waitMs, not a repo, a parent that is a file).
 */
const SWEEP_REASONS = HOSTILE_REASONS;
/** A fresh fault per run: the first call throws `code`, later calls go to `real`. */
const failOnce = (code) => (real) => { let left = 1; return (...a) => { if (left-- > 0) throw Object.assign(new Error(`${code}: injected`), { code }); return real(...a); }; };
const SWEEP_SCENARIOS = [
  { name: 'free lock', waits: [undefined, 1000] },
  { name: 'stale holder', waits: [undefined, 1000], setup: (f) => writeFileSync(f, record(EXITED_PID)) },
  { name: 'live holder released at sleep 2', waits: [1000], setup: (f) => writeFileSync(f, record(4242)), releaseAtSleep: 2 },
  { name: 'live holder released at sleep 2, rejecting sleep', waits: [1000], setup: (f) => writeFileSync(f, record(4242)), releaseAtSleep: 2, rejectingSleep: true },
  { name: 'live holder that never releases (lock_held, then lock_timeout at the deadline)', waits: [undefined, 100], setup: (f) => writeFileSync(f, record(4242)), fails: true },
  { name: 'free lock, cancellation unlink fails once', waits: [undefined, 1000], unlinkFault: failOnce('EPERM') },
  { name: 'free lock, removed by someone between the cancellation read and unlink (ENOENT: not a leak)', waits: [undefined, 1000], unlinkVanish: true },
  { name: 'free lock, cancellation read fails once', waits: [undefined, 1000], readFault: failOnce('EACCES') },
  { name: 'stale holder, cancellation unlink fails once', waits: [undefined, 1000], setup: (f) => writeFileSync(f, record(EXITED_PID)), unlinkFault: failOnce('EBUSY') },
  { name: 'free lock replaced by a successor right after our create', waits: [undefined, 1000], tamper: 'replace' },
  { name: 'free lock removed by someone right after our create', waits: [undefined, 1000], tamper: 'remove' },
  { name: 'setup error: bad waitMs', waits: [-1] },
  { name: 'setup error: not a git work tree', waits: [undefined, 1000], ctx: (dir) => ({ repoRoot: dir, ticket: 'T', runId: 'r' }) },
  { name: 'setup error: lock parent is a file', waits: [undefined, 1000], ctx: (dir) => { writeFileSync(join(dir, 'occupied'), 'x'); return { lockFile: join(dir, 'occupied', 'document.lock'), runId: 'r' }; } },
];
/** No work starts after an abort: `attempt` and `commit` are markers just before a check, so they may follow the abort; these may not. */
const FORBIDDEN_AFTER_ABORT = ['acquired', 'hook', 'sleep'];

const DEFERS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const MAX_DEFER = DEFERS[DEFERS.length - 1];
/** `probe`: at every step k, queue MAX_DEFER chained microtasks ending in `probe:k` (boundary coverage). */
async function sweepRun(dir, sc, waitMs, at, defer, reasonFn, probe = false) {
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir);
  const lockFile = join(dir, 'document.lock');
  sc.setup?.(lockFile);
  const ctx = sc.ctx ? sc.ctx(dir) : ctxIn(dir, { processInfo: (pid) => (pid === EXITED_PID ? { alive: false, startTime: null } : { alive: true, startTime: null }) });
  ctx.hooks = { boundary: async () => { await Promise.resolve(); } };
  const read = () => (existsLock(lockFile) ? readFileSync(lockFile, 'utf8') : null);
  let external = read(); // what the lock file must hold if this call never took the lock
  const controller = new AbortController(), log = [];
  let reason, steps = 0, sleeps = 0, t = 0;
  // a1: one microtask after the abort. A rejection reacts (`settled`) before a1 only if it came first.
  controller.signal.addEventListener('abort', () => { log.push('abort'); queueMicrotask(() => log.push('a1')); });
  const fire = () => { reason = reasonFn(); controller.abort(reason); };
  const schedule = () => {
    if (defer === 0) return fire();
    let p = Promise.resolve();
    for (let i = 1; i < defer; i++) p = p.then(() => {});
    p.then(fire);
  };
  const seam = {
    step: (name) => {
      log.push(name);
      // I1 oracle: the success return must resolve the call before a microtask queued here twice runs.
      if (name === 'commit') queueMicrotask(() => queueMicrotask(() => log.push('m2')));
      // Someone broke our lock and took it (a hand removal plus a new engine): ours is gone, theirs must survive.
      if (name === 'acquired' && sc.tamper) {
        unlinkSync(lockFile);
        if (sc.tamper === 'replace') writeFileSync(lockFile, record(4242, { nonce: 'successor' }));
        external = read();
      }
      if (++steps === at) schedule();
      log.push(`${name}:done`); // an abort logged before this was raised at or before this boundary
      if (probe) { const k = steps; let q = Promise.resolve(); for (let i = 1; i < MAX_DEFER; i++) q = q.then(() => {}); q.then(() => log.push(`probe:${k}`)); }
    },
    ...(sc.unlinkFault && { unlinkLock: sc.unlinkFault(unlinkSync) }),
    ...(sc.unlinkVanish && { unlinkLock: (f) => { unlinkSync(f); external = null; throw Object.assign(new Error('ENOENT: removed by someone else first'), { code: 'ENOENT' }); } }),
    ...(sc.readFault && { readLock: sc.readFault(readFileSync) }),
  };
  const sleep = async (ms, sig) => {
    if (sc.rejectingSleep && sig?.aborted) throw new Error('sleep refused: already aborted');
    t += ms;
    if (++sleeps === sc.releaseAtSleep) { unlinkSync(lockFile); external = null; }
    await Promise.resolve();
    if (sc.rejectingSleep && sig?.aborted) throw new Error('sleep interrupted');
  };
  if (at === 0) fire();
  const call = acquireLock(ctx, { waitMs, signal: controller.signal, now: () => t, sleep, [TEST_SEAM]: seam });
  const outcome = await call.then((handle) => { log.push('settled'); return { handle }; }, (error) => { log.push('settled'); return { error }; });
  for (let i = 0; i <= Math.max(defer, probe ? MAX_DEFER : 0) + 2; i++) await Promise.resolve(); // let late aborts, probes and m2 land
  return { outcome, log, steps, reason, signal: controller.signal, lockFile, after: read(), external, tampered: Boolean(sc.tamper), faulted: Boolean(sc.unlinkFault || sc.readFault), entries: readdirSync(dir) };
}

/** Every violated postcondition of one run (empty when it satisfies I1-I4). */
function sweepViolations(r, base, defer) {
  const v = [], { outcome, log } = r;
  const ab = log.indexOf('abort'), fired = ab >= 0;
  const acquired = log.includes('acquired');
  const ours = (s) => { try { const j = JSON.parse(s); return j.run_id === 'r' && j.pid === process.pid; } catch { return false; } };
  if (r.entries.some((e) => e.endsWith('.recovery'))) v.push('a recovery marker was left');
  if (fired) for (const name of FORBIDDEN_AFTER_ABORT) if (log.indexOf(name, ab) > ab) v.push(`step ${name} ran after the abort`);
  if ('handle' in outcome) {
    if (!('handle' in base)) v.push('resolved where the unaborted call rejects');
    if (fired && ab < log.indexOf('commit:done')) v.push('I1: resolved with a handle although the abort came at or before the success exit');
    if (!(log.indexOf('settled') < log.indexOf('m2'))) v.push('I1: the success exit did not resolve the call in the same turn as its check');
    if (r.tampered ? r.after !== r.external : !ours(r.after)) v.push(r.tampered ? 'the tampered lock file was touched' : 'resolved without owning the lock');
    return v;
  }
  const e = outcome.error;
  if (fired && Object.is(e, r.signal.reason)) {
    if (acquired && !r.tampered ? r.after !== null : r.after !== r.external) v.push(`rejected with the reason but the lock file is ${acquired ? 'still present after we took it' : 'not as the holder left it'}`);
    return v;
  }
  if (e?.code === 'lock_cancel_leaked') {
    if (!fired) v.push('leak reported without an abort');
    if (!r.faulted) v.push('I3: leak reported where no release fault was injected');
    if (!(e instanceof AggregateError) || !Object.is(e.errors[0], r.signal.reason) || !Object.is(e.reason, r.signal.reason) || e.errors[1] !== e.cause || e.cause?.code === undefined) v.push('I3: the leak error does not carry the reason and the failure');
    if (!acquired) v.push('I3: leak reported for a lock this call never took');
    if (e.leakedLock?.lockFile !== r.lockFile || !ours(r.after) || JSON.parse(r.after).nonce !== e.leakedLock?.nonce) v.push('I3: leakedLock does not describe the lock left on disk');
    return v;
  }
  // Neither the reason nor a leak: it must be the unaborted call's own error, with no abort before it.
  if (!('error' in base) || e?.code !== base.error?.code || e?.name !== base.error?.name) v.push(`rejected with ${String(e?.code ?? e?.message ?? e)}, which is neither the reason nor the unaborted outcome`);
  if (fired && !(log.indexOf('settled') < log.indexOf('a1'))) v.push('I2/I4: an abort that came before the failure did not win over it');
  if (r.after !== r.external) v.push('the lock file changed on a refused call');
  return v;
}

test('I1-I5 cancellation sweep: every boundary x scenario x hostile reason ends in a handle taken before the abort, or the reason, never an owned lock', async (t) => {
  const dir = scratch(t);
  const violations = [], classes = { 'deferred success': 0, 'plain reject': 0, 'won then released': 0, leak: 0, 'pre-aborted': 0, 'late abort after a refusal': 0 };
  let cases = 0;
  for (const sc of SWEEP_SCENARIOS) {
    for (const waitMs of sc.waits) {
      const base = await sweepRun(dir, sc, waitMs, -1, 0, () => null, true);
      if (base.outcome.handle) await base.outcome.handle.release();
      // Every boundary is visited: from each step, the longest deferral lands at or past the next
      // step (or after the call settled), so deferrals 0..MAX_DEFER cover each gap between steps.
      const stepIdx = base.log.map((e, i) => [e, i]).filter(([e]) => !['settled', 'm2'].includes(e) && !e.startsWith('probe:') && !e.endsWith(':done')).map(([, i]) => i);
      for (let k = 1; k <= base.steps; k++) {
        const landed = base.log.indexOf(`probe:${k}`), next = k < base.steps ? stepIdx[k] : base.log.indexOf('settled');
        assert.ok(landed > next, `${sc.name}, waitMs ${waitMs}: ${MAX_DEFER} microtasks from step ${k} (${base.log[stepIdx[k - 1]]}) reach the next boundary (${base.log.join(' ')})`);
      }
      const expectSuccess = !sc.name.startsWith('setup error') && !sc.fails;
      assert.equal('handle' in base.outcome, expectSuccess, `${sc.name}: the unaborted baseline ${expectSuccess ? 'acquires' : 'fails'}`);
      for (let at = 0; at <= base.steps; at++) {
        for (const defer of at === 0 ? [0] : DEFERS) {
          for (const [label, reason] of SWEEP_REASONS) {
            cases++;
            const r = await sweepRun(dir, sc, waitMs, at, defer, reason);
            const where = `${sc.name}, waitMs ${waitMs}, abort at step ${at}/${base.steps} (${r.log[r.log.indexOf('abort') - 1] ?? 'before the call'}) +${defer} microtasks, reason ${label}`;
            for (const m of sweepViolations(r, base.outcome, defer)) violations.push(`${where}: ${m}`);
            const fired = r.log.includes('abort');
            if ('handle' in r.outcome) { if (fired) classes['deferred success']++; await r.outcome.handle.release(); }
            else if (r.outcome.error?.code === 'lock_cancel_leaked') {
              classes.leak++;
              if (typeof r.outcome.error.leakedLock?.release !== 'function') continue; // already a violation above
              try { await r.outcome.error.leakedLock.release(); } catch (e) { violations.push(`${where}: leakedLock.release() threw ${e?.code ?? e}`); }
              if (existsLock(r.lockFile)) violations.push(`${where}: leakedLock.release() did not remove the leaked lock`);
            }
            else if (at === 0) classes['pre-aborted']++;
            else if (fired && Object.is(r.outcome.error, r.signal.reason)) classes[r.log.includes('acquired') ? 'won then released' : 'plain reject']++;
            else if (fired) classes['late abort after a refusal']++;
          }
        }
      }
    }
  }
  t.diagnostic(`sweep cases: ${cases}; ${JSON.stringify(classes)}`);
  assert.deepEqual(violations.slice(0, 20), [], `${violations.length} violations`);
  for (const [k, n] of Object.entries(classes)) assert.ok(n > 0, `the sweep produced at least one '${k}' outcome (non-vacuity)`);
  assert.ok(cases > 7000, `the sweep ran (${cases} cases)`);
});

test('I1 regression (Codex round 3): an abort queued in the microtasks after the call never leaves an owned handle with a cancelled caller', async (t) => {
  // Codex's repro on 4e487d9: free lock, waitMs set, queueMicrotask(abort): the call resolved with an
  // owned handle after the abort. Here the abort is queued 1..10 microtasks after the call returns.
  const dir = scratch(t), lockFile = join(dir, 'document.lock');
  const seen = { resolved: 0, rejected: 0 };
  for (const [lock, stale] of [['free', false], ['stale (async hook)', true]]) for (const waitMs of [undefined, 1000]) {
    for (let d = 1; d <= 10; d++) {
      if (stale) writeFileSync(lockFile, record(EXITED_PID));
      const controller = new AbortController(), reason = { code: 'lock_held', why: 'hostile' }, log = [];
      controller.signal.addEventListener('abort', () => log.push('abort'));
      const ctx = ctxIn(dir, { processInfo: deadFor(EXITED_PID), hooks: { boundary: async () => { await Promise.resolve(); } } });
      const call = acquireLock(ctx, { waitMs, signal: controller.signal, [TEST_SEAM]: { step: (n) => log.push(n) } });
      let p = Promise.resolve();
      for (let i = 1; i < d; i++) p = p.then(() => {});
      p.then(() => controller.abort(reason));
      const r = await call.then((handle) => ({ handle }), (error) => ({ error }));
      for (let i = 0; i <= d; i++) await Promise.resolve();
      assert.ok(log.includes('abort'), `${lock}, waitMs ${waitMs} +${d}: the abort fired`);
      if (r.handle) {
        seen.resolved++;
        assert.ok(log.indexOf('commit') < log.indexOf('abort'), `${lock}, waitMs ${waitMs} +${d}: a handle is returned only when the abort came after the success exit (${log.join(' ')})`);
        assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).pid, process.pid);
        await r.handle.release();
      } else {
        seen.rejected++;
        assert.ok(Object.is(r.error, reason), `${lock}, waitMs ${waitMs} +${d}: rejected with exactly the reason`);
        assert.ok(!log.includes('commit') || log.indexOf('abort') < log.indexOf('commit'), `${lock}, waitMs ${waitMs} +${d}: rejected only for an abort that preceded the success exit (${log.join(' ')})`);
        if (stale && !log.includes('acquired')) assert.equal(readFileSync(lockFile, 'utf8'), record(EXITED_PID), `${lock} +${d}: an abort before the recovery leaves the record`);
        if (existsLock(lockFile)) unlinkSync(lockFile);
      }
      assert.deepEqual(readdirSync(dir), [], `${lock}, waitMs ${waitMs} +${d}: nothing owned or left after the caller released`);
    }
  }
  assert.ok(seen.rejected > 0 && seen.resolved > 0, `both sides of the boundary were reached: ${JSON.stringify(seen)}`);
});

test('I4 a pre-aborted signal beats every setup error and does no work: no probe, no directory, no git call', async (t) => {
  const dir = scratch(t);
  for (const [label, reasonFn] of HOSTILE_REASONS) {
    const signal = AbortSignal.abort(reasonFn());
    const probes = [];
    const nested = join(dir, 'missing', 'document.lock');
    const cases = [
      [{ lockFile: nested, runId: 'r', processInfo: (pid) => { probes.push(pid); return null; } }, { waitMs: -1 }],
      [{ repoRoot: join(dir, 'no-such-dir'), ticket: 'T', runId: 'r' }, {}],
      [{ lockFile: nested, runId: 'r', processInfo: (pid) => { probes.push(pid); return null; } }, { waitMs: 1000 }],
    ];
    for (const [ctx, opts] of cases) await assert.rejects(acquireLock(ctx, { ...opts, signal }), (e) => Object.is(e, signal.reason), label);
    assert.deepEqual(probes, [], `${label}: no processInfo probe`);
    assert.deepEqual(readdirSync(dir), [], `${label}: the lock directory was not created`);
  }
});

test('I3 a failed release during cancellation is reported with the reason and a recoverable leakedLock; the normal release stays best effort', async (t) => {
  const dir = scratch(t), lockFile = join(dir, 'document.lock');
  for (const [fault, code] of [['unlinkLock', 'EPERM'], ['readLock', 'EACCES']]) {
    const controller = new AbortController(), reason = new Error(`stop (${fault})`);
    const failure = Object.assign(new Error(`${code}: injected`), { code });
    let failing = true;
    const seam = { step: (name) => { if (name === 'acquired') controller.abort(reason); },
      [fault]: (...a) => { if (failing) { failing = false; throw failure; } return (fault === 'unlinkLock' ? unlinkSync : readFileSync)(...a); } };
    const err = await acquireLock(ctxIn(dir), { signal: controller.signal, [TEST_SEAM]: seam }).then(() => assert.fail('resolved'), (e) => e);
    assert.ok(err instanceof AggregateError, fault);
    assert.equal(err.code, 'lock_cancel_leaked');
    assert.deepEqual([err.errors[0], err.errors[1], err.reason, err.cause], [reason, failure, reason, failure]);
    assert.equal(err.leakedLock.lockFile, lockFile);
    assert.equal(err.leakedLock.pid, process.pid);
    assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).nonce, err.leakedLock.nonce, `${fault}: the leaked lock is on disk, ours`);
    await err.leakedLock.release();
    assert.deepEqual(readdirSync(dir), [], `${fault}: leakedLock.release() recovers it`);
  }
  // A lock that is no longer ours (or gone) is not a leak: the plain reason.
  const controller = new AbortController(), reason = new Error('stop');
  const seam = { step: (name) => { if (name === 'acquired') { controller.abort(reason); writeFileSync(lockFile, record(4242, { nonce: 'successor' })); } } };
  await assert.rejects(acquireLock(ctxIn(dir), { signal: controller.signal, [TEST_SEAM]: seam }), (e) => e === reason);
  assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).nonce, 'successor', 'a successor lock is never removed');
  // handle.release() keeps its documented behaviour: it never throws (here: the lock is a directory).
  unlinkSync(lockFile);
  const h = await must(acquireLock(ctxIn(dir)));
  unlinkSync(lockFile); mkdirSync(lockFile);
  await h.release();
  assert.ok(statSync(lockFile).isDirectory());
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
 * read, writes, and waits until all six have written, so each round adds exactly 1. Every barrier
 * wait is bounded: a stranded child reports which barrier and exits 3 (a failure, never a pass).
 */
const BARRIER_BOUND_MS = 30_000;
const WORKER = `
const [lib, dir, file, lockFile, n, mode, id, bound] = process.argv.slice(1);
const { readFileSync, readdirSync, writeFileSync } = await import('node:fs');
const { join } = await import('node:path');
const { performance } = await import('node:perf_hooks');
const { acquireLock, writeStateAtomic } = await import(lib);
const mark = (name) => writeFileSync(join(dir, name), '');
const until = async (ok, what) => {
  const end = performance.now() + Number(bound);
  while (!ok()) {
    if (performance.now() > end) { process.stderr.write('child ' + id + ': barrier ' + what + ' not reached in ' + bound + ' ms\\n'); process.exit(3); }
    await new Promise(r => setTimeout(r, 2));
  }
};
const all = (prefix) => () => readdirSync(dir).filter(e => e.startsWith(prefix)).length === 6;
mark('ready-' + id);
await until(() => readdirSync(dir).includes('go'), 'go');
for (let i = 0; i < Number(n); i++) {
  const h = mode === 'lock' ? await acquireLock({ lockFile, runId: 'w' }, { waitMs: 60000 }) : null;
  const v = JSON.parse(readFileSync(file, 'utf8')).n;
  if (mode === 'race') { mark('r' + i + '-read-' + id); await until(all('r' + i + '-read-'), 'r' + i + '-read'); }
  await writeStateAtomic(file, { n: v + 1 });
  if (mode === 'race') { mark('r' + i + '-wrote-' + id); await until(all('r' + i + '-wrote-'), 'r' + i + '-wrote'); }
  await h?.release();
}`;

/**
 * Run six workers. Exit and spawn-error handlers are attached at spawn; a child that exits before
 * the start barrier, or fails afterwards, fails the run at once; every wait is bounded; every child
 * still running is killed in `finally`, on every path.
 */
async function contend(t, mode) {
  const dir = scratch(t);
  const file = join(dir, 'counter.json'), lockFile = join(dir, 'counter.lock');
  await writeStateAtomic(file, { n: 0 });
  const lib = new URL('./durable-io.mjs', import.meta.url).href;
  const kids = [], exits = [], errs = [];
  const describe = () => errs.join('') || '(no stderr)';
  try {
    for (let id = 0; id < 6; id++) {
      const k = spawn(process.execPath, ['--input-type=module', '-e', WORKER, lib, dir, file, lockFile, '15', mode, String(id), String(BARRIER_BOUND_MS)], { stdio: ['ignore', 'ignore', 'pipe'] });
      k.stderr.on('data', (d) => errs.push(String(d)));
      // Never rejects: an exit or a spawn error resolves it.
      exits.push(new Promise((resolve) => { k.once('exit', (code, signal) => resolve({ id, code, signal })); k.once('error', (error) => resolve({ id, code: null, error })); }));
      kids.push(k);
    }
    let gone = null;
    exits.forEach((p) => p.then((r) => { gone ??= r; }));
    const readyBy = performance.now() + BARRIER_BOUND_MS;
    while (readdirSync(dir).filter(e => e.startsWith('ready-')).length < 6) {
      if (gone) assert.fail(`child ${gone.id} ended before the start barrier (code ${gone.code}, ${gone.error ?? gone.signal}): ${describe()}`);
      if (performance.now() > readyBy) assert.fail(`children not ready within ${BARRIER_BOUND_MS} ms: ${describe()}`);
      await new Promise(r => setTimeout(r, 5));
    }
    writeFileSync(join(dir, 'go'), '');
    let timer;
    const bound = new Promise((resolve) => { timer = setTimeout(() => resolve('bound'), 2 * BARRIER_BOUND_MS + 60_000); });
    const firstFailure = new Promise((resolve) => exits.forEach((p) => p.then((r) => { if (r.code !== 0) resolve(r); })));
    const done = await Promise.race([Promise.all(exits), firstFailure, bound]).finally(() => clearTimeout(timer));
    if (done === 'bound') assert.fail(`children did not finish within the bound: ${describe()}`);
    if (!Array.isArray(done)) assert.fail(`child ${done.id} failed (code ${done.code}, ${done.error ?? done.signal}): ${describe()}`);
    return { n: JSON.parse(readFileSync(file, 'utf8')).n, left: readdirSync(dir).filter(e => e.startsWith('counter.lock')) };
  } finally {
    for (const k of kids) if (k.exitCode === null && k.signalCode === null) k.kill('SIGKILL');
    await Promise.all(exits);
  }
}

test('AC6 / Z S1b 6 processes x 15 increments lose no update under the lock; without it, the forced interleaving loses 75', { skip: WIN ? 'POSIX only here: Windows delete-pending and rename semantics under this load are unverified (follow-up)' : false }, async (t) => {
  const locked = await contend(t, 'lock');
  assert.equal(locked.n, 90);
  assert.deepEqual(locked.left, []);
  const bare = await contend(t, 'race');
  assert.equal(bare.n, 15, 'the negative control loses exactly the 75 interleaved updates');
});

test('zero unhandled rejections in this test process', () => {
  assert.deepEqual(UNHANDLED, []);
});
