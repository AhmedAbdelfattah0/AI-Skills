/**
 * context-manifest.mjs (P0 slice E4). The first test is the CI gate: the committed
 * references/context-manifest.json must describe the references exactly as committed, so editing a
 * reference without `node skills/ship-ticket/scripts/context-manifest.mjs build` fails here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, cpSync, mkdtempSync, rmSync, unlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SKILL_DIR, MANIFEST_REL, PHASE_REFS, buildManifest, manifestText, verifySkill, deliverPhase, sha256 } from './context-manifest.mjs';

const CLI = fileURLToPath(new URL('./context-manifest.mjs', import.meta.url));

test('CI gate: the committed manifest verifies and is byte-identical to a rebuild', () => {
  const v = verifySkill();
  assert.equal(v.ok, true, `${v.code}: ${v.reasons?.join('; ')} (run: node skills/ship-ticket/scripts/context-manifest.mjs build)`);
  assert.equal(readFileSync(join(SKILL_DIR, MANIFEST_REL), 'utf8'), manifestText(buildManifest()), 'manifest is not the output of build');
  const r = spawnSync(process.execPath, [CLI, 'verify'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^context-manifest: ok sha256:[0-9a-f]{64}$/m);
});

test('every phase lists only existing references, and each phase delivers exactly those bytes', () => {
  for (const [phase, list] of Object.entries(PHASE_REFS)) {
    const d = deliverPhase(phase);
    assert.equal(d.ok, true, phase);
    assert.deepEqual(d.inventory.map(i => i.path), list);
    for (const p of list) {
      const bytes = readFileSync(join(SKILL_DIR, p));
      assert.ok(d.text.includes(`===== BEGIN ${p} ${sha256(bytes)} =====\n${bytes.toString('utf8')}`), p);
    }
  }
  assert.equal(deliverPhase('prove-everything').code, 'phase_unknown');
});

function copy(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'context-manifest-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(SKILL_DIR, 'references'), join(dir, 'references'), { recursive: true });
  return dir;
}

test('verify fails on a changed, missing or extra reference, a hand-edited manifest and changed phases', (t) => {
  const dir = copy(t);
  const code = () => verifySkill(dir).code;
  const cli = () => spawnSync(process.execPath, [CLI, 'verify', '--skill', dir], { encoding: 'utf8' });
  assert.equal(code(), 'verified');
  const units = join(dir, 'references', 'units.md'); // not mandatory for any phase, still covered
  const before = readFileSync(units);
  writeFileSync(units, Buffer.concat([before, Buffer.from(' ')]));
  assert.equal(code(), 'reference_changed');
  const r = cli();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /reference_changed: references\/units\.md/);
  assert.equal(deliverPhase('build', dir).code, 'reference_changed', 'any drift blocks every phase delivery');
  writeFileSync(units, before);
  writeFileSync(join(dir, 'references', 'new.md'), 'x');
  assert.equal(code(), 'reference_extra');
  unlinkSync(join(dir, 'references', 'new.md'));
  unlinkSync(join(dir, 'references', 'ship.md'));
  assert.equal(code(), 'reference_missing');
  writeFileSync(join(dir, 'references', 'ship.md'), 'replacement');
  const m = JSON.parse(readFileSync(join(dir, MANIFEST_REL), 'utf8'));
  m.files['references/ship.md'] = sha256(Buffer.from('replacement'));
  m.phases.ship = [];
  writeFileSync(join(dir, MANIFEST_REL), JSON.stringify(m));
  assert.equal(code(), 'manifest_phases_changed');
  writeFileSync(join(dir, MANIFEST_REL), 'not json');
  assert.equal(code(), 'manifest_invalid');
  assert.equal(spawnSync(process.execPath, [CLI, 'build', '--skill', dir]).status, 0);
  assert.equal(code(), 'verified', 'build repairs it');
  assert.equal(spawnSync(process.execPath, [CLI, 'nonsense']).status, 2);
});
