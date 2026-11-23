/**
 * S-28b b0: resolveTool and pinnedTool (remote-identity.mjs, ported from a890b0d engine-ci.mjs:253-282).
 * The rest of remote-identity.mjs is covered by engine-base.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as RI from './remote-identity.mjs';

const { resolveTool, pinnedTool } = RI;
const toolCandidates = (...a) => RI.toolCandidates(...a);

const posix = process.platform !== 'win32';
const sha = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');
function bins(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'remote-identity-tools-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const a = join(root, 'a'), b = join(root, 'b');
  mkdirSync(a); mkdirSync(b);
  return { root, a, b };
}

test('resolveTool returns the realpath and sha256 of the FIRST executable on PATH; none -> null', { skip: !posix }, (t) => {
  const { a, b } = bins(t);
  writeFileSync(join(a, 'gh'), 'first'); chmodSync(join(a, 'gh'), 0o755);
  writeFileSync(join(b, 'gh'), 'second'); chmodSync(join(b, 'gh'), 0o755);
  assert.deepEqual(resolveTool('gh', { PATH: [a, b].join(delimiter) }), { path: join(a, 'gh'), sha256: sha('first') });
  assert.deepEqual(resolveTool('gh', { PATH: [b, a].join(delimiter) }), { path: join(b, 'gh'), sha256: sha('second') });
  assert.equal(resolveTool('gh', { PATH: '' }), null);
  assert.equal(resolveTool('no-such-tool', { PATH: [a, b].join(delimiter) }), null);
  assert.equal(resolveTool('a', { PATH: dirOf(a) }), null, 'a directory is not an executable');
});
const dirOf = (p) => p.slice(0, p.lastIndexOf('/'));

test('resolveTool resolves a symlink to its real file', { skip: !posix }, (t) => {
  const { a, b } = bins(t);
  writeFileSync(join(b, 'real-gh'), 'real'); chmodSync(join(b, 'real-gh'), 0o755);
  symlinkSync(join(b, 'real-gh'), join(a, 'gh'));
  assert.deepEqual(resolveTool('gh', { PATH: a }), { path: join(b, 'real-gh'), sha256: sha('real') });
});

test('pinnedTool: the pinned file verifies; unpinned, drifted and missing files are refused with their code', { skip: !posix }, (t) => {
  const { a } = bins(t);
  const p = join(a, 'gh');
  writeFileSync(p, 'v1'); chmodSync(p, 0o755);
  const pin = resolveTool('gh', { PATH: a });
  assert.deepEqual(pinnedTool(pin), { ok: true, path: p });
  for (const none of [null, undefined]) { // {} and { sha256 } are malformed pins since Round 1 (gh_pin_invalid, below)
    const r = pinnedTool(none);
    assert.equal(r.ok, false); assert.equal(r.code, 'gh_unpinned'); assert.match(r.reason, /no gh was pinned/);
  }
  assert.equal(pinnedTool(pin, 'codex').ok, true);
  assert.equal(pinnedTool(null, 'codex').code, 'codex_unpinned');
  writeFileSync(p, 'v2-a stub put in place after the pin');
  const drift = pinnedTool(pin);
  assert.equal(drift.ok, false); assert.equal(drift.code, 'gh_drift'); assert.match(drift.reason, new RegExp(pin.sha256));
  rmSync(p);
  const gone = pinnedTool(pin);
  assert.equal(gone.code, 'gh_drift'); assert.match(gone.reason, /now missing/);
});

// ---- Round 1 repair (PR #121): pinnedTool fails closed on every pin shape and every read failure; resolveTool means "executable" ----

const HEX = 'sha256:' + 'a'.repeat(64);
test('pinnedTool refuses a malformed pin (<name>_pin_invalid), never compares a failed read with a null digest', { skip: !posix }, (t) => {
  const { a } = bins(t);
  for (const bad of [
    { path: '/no/such/gh', sha256: null },        // Round 1 MAJOR B: the null digest equalled the null of a failed read
    { path: a, sha256: null },                    // a directory with a null digest
    { path: '/no/such/gh' },
    { sha256: HEX }, {},                          // no path: a corrupt record, not "nothing was pinned"
    { path: 'relative/gh', sha256: HEX }, { path: '', sha256: HEX }, { path: 5, sha256: HEX },
    { path: '/usr/bin/gh', sha256: 'a'.repeat(64) }, { path: '/usr/bin/gh', sha256: 'sha256:' + 'A'.repeat(64) },
    { path: '/usr/bin/gh', sha256: HEX + 'a' }, { path: '/usr/bin/gh\0', sha256: HEX },
    { path: '\\gh', sha256: HEX }, { path: 'C:\\gh', sha256: HEX }, // absolute on win32 only: relative to the cwd here
    'gh', 7, [HEX],
  ]) {
    const r = pinnedTool(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.code, 'gh_pin_invalid', JSON.stringify(bad));
  }
  assert.equal(pinnedTool({ path: 'x', sha256: HEX }, 'codex').code, 'codex_pin_invalid');
  for (const none of [null, undefined]) assert.equal(pinnedTool(none).code, 'gh_unpinned');
});

test('pinnedTool refuses a pinned path that is now a directory, a symlink, a FIFO (without blocking) or unreadable', { skip: !posix }, (t) => {
  const { a, b } = bins(t);
  const p = join(a, 'gh');
  writeFileSync(p, 'v1'); chmodSync(p, 0o755);
  const pin = resolveTool('gh', { PATH: a });
  // a directory put where the pinned file was, with a well-formed digest
  rmSync(p); mkdirSync(p);
  let r = pinnedTool(pin);
  assert.equal(r.code, 'gh_drift'); assert.match(r.reason, /not a regular file/);
  // a symlink to a file with the pinned bytes: the pin is the realpath, so a link there is a replacement
  rmSync(p, { recursive: true }); writeFileSync(join(b, 'same'), 'v1'); symlinkSync(join(b, 'same'), p);
  r = pinnedTool(pin);
  assert.equal(r.code, 'gh_drift'); assert.match(r.reason, /symbolic link/);
  // a FIFO: refused, the read never blocks
  rmSync(p); assert.equal(spawnSync('mkfifo', [p]).status, 0);
  r = pinnedTool(pin);
  assert.equal(r.code, 'gh_drift'); assert.match(r.reason, /not a regular file/);
  // unreadable (skipped as root, who reads anything)
  rmSync(p); writeFileSync(p, 'v1'); chmodSync(p, 0o000);
  if (process.getuid?.() !== 0) { r = pinnedTool(pin); assert.equal(r.code, 'gh_unreadable'); assert.match(r.reason, /cannot be read/); }
  chmodSync(p, 0o755);
  assert.deepEqual(pinnedTool(pin), { ok: true, path: p }, 'the restored file verifies again');
});

test('resolveTool skips a non-executable file and a relative PATH entry; a name with a separator is refused', { skip: !posix }, (t) => {
  const { root, a, b } = bins(t);
  writeFileSync(join(a, 'gh'), 'not executable'); chmodSync(join(a, 'gh'), 0o644);
  writeFileSync(join(b, 'gh'), 'exec'); chmodSync(join(b, 'gh'), 0o755);
  assert.deepEqual(resolveTool('gh', { PATH: [a, b].join(delimiter) }), { path: join(b, 'gh'), sha256: sha('exec') }, 'the FIRST EXECUTABLE, not the first file');
  const cwd = process.cwd();
  t.after(() => process.chdir(cwd));
  process.chdir(root);
  chmodSync(join(a, 'gh'), 0o755);
  assert.equal(resolveTool('gh', { PATH: 'a' }), null, 'a relative PATH entry resolves against the cwd: never used');
  assert.deepEqual(resolveTool('gh', { PATH: ['a', '.', b].join(delimiter) }), { path: join(b, 'gh'), sha256: sha('exec') });
  for (const bad of ['a/gh', '../gh', 'x\\gh', '', '.', '..', 'g\0h', 5, null]) assert.throws(() => resolveTool(bad, { PATH: b }), TypeError, String(bad));
});

test('toolCandidates (pure): the win32 branch tries <name>.exe then <name>.cmd in each absolute PATH entry, never the bare name', () => {
  assert.deepEqual(toolCandidates('gh', { Path: 'C:\\bin;rel\\dir;;D:\\x\\' }, 'win32'), ['C:\\bin\\gh.exe', 'C:\\bin\\gh.cmd', 'D:\\x\\gh.exe', 'D:\\x\\gh.cmd']);
  assert.deepEqual(toolCandidates('gh', { PATH: '/usr/bin:rel::/opt/b' }, 'linux'), ['/usr/bin/gh', '/opt/b/gh']);
  assert.deepEqual(toolCandidates('gh', {}, 'linux'), []);
});

test('resolveTool on Windows resolves gh.exe and skips a bare gh', { skip: posix }, (t) => {
  const { a, b } = bins(t);
  writeFileSync(join(a, 'gh'), 'bare');
  writeFileSync(join(b, 'gh.exe'), 'exe');
  assert.deepEqual(resolveTool('gh', { PATH: [a, b].join(delimiter) }), { path: join(b, 'gh.exe'), sha256: sha('exe') });
});
