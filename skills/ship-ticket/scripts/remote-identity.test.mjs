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
import { resolveTool, pinnedTool } from './remote-identity.mjs';

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
  for (const none of [null, undefined, {}, { sha256: pin.sha256 }]) {
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
