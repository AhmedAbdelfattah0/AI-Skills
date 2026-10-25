// Revision closure, measured layout and deliverable-path safety. Pure or
// temp-directory tests; no renderer or browser is needed.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { evidenceFrames, layoutFindings, silenceFindings } from './lib/qa.mjs';
import { classifyShots, globalsDigest, shotHashes } from './lib/revision.mjs';
import { deliverablePath, ensureRestricted, runWritePath } from './lib/run.mjs';

const timeline = {
  fps: 30, width: 1080, height: 1920, preset: 'reel',
  shots: [{ id: 'a', assetId: 'x', durationFrames: 60 }, { id: 'b', assetId: 'x', durationFrames: 60 }],
  text: [{ id: 't', shotId: 'b', kind: 'caption', startFrame: 0, endFrame: 30 }],
};
const manifest = { assets: [{ id: 'x', sha256: '1'.repeat(64) }] };
const project = { brand: { colors: { primary: '#4f46e5' } }, exportPresets: { reel: { safeZone: { top: 220 } } } };
const globals = (p, t) => globalsDigest({ compositionDigest: 'c', lockDigest: 'l', renderSettings: { crf: 18 }, project: p, timeline: t });
const side = (p, t) => ({ globalsDigest: globals(p, t), shotHashes: shotHashes(t, manifest) });

test('editing one shot affects only that shot', () => {
  const next = structuredClone(timeline);
  next.shots[0].durationFrames = 45;
  const r = classifyShots(side(project, timeline), side(project, next));
  assert.equal(r.globalsChanged, false);
  assert.deepEqual(r.shots.map((s) => [s.id, s.affected]), [['a', true], ['b', false]]);
});

test('a palette change puts every shot in the affected closure', () => {
  const recoloured = structuredClone(project);
  recoloured.brand.colors.primary = '#000000';
  const r = classifyShots(side(project, timeline), side(recoloured, timeline));
  assert.equal(r.globalsChanged, true);
  assert.ok(r.shots.every((s) => s.affected && s.reason === 'global inputs changed'));
});

test('a caption edit affects its own shot only', () => {
  const next = structuredClone(timeline);
  next.text[0].text = 'changed';
  const r = classifyShots(side(project, timeline), side(project, next));
  assert.deepEqual(r.shots.filter((s) => s.affected).map((s) => s.id), ['b']);
});

test('evidence includes both sides of every boundary and the last frame', () => {
  const frames = evidenceFrames(timeline).map((f) => f.frame);
  for (const f of [0, 58, 59, 60, 62, 119]) assert.ok(frames.includes(f), `frame ${f}`);
});

// Measurements below were captured from real renders on 2026-10-25: an
// oversized Arabic caption, and the first-frame unsized sample.
// Text item t spans absolute frames 60..89, so its probes are 60, 75 and 89.
const at = (frame, box = {}) => ({ id: 't', frame, x: 64, y: 1372, w: 952, h: 128, scrollW: 952, clientW: 952, scrollH: 128, clientH: 128, ...box });

test('a fully measured caption inside the safe zone passes', () => {
  assert.equal(layoutFindings(timeline, [at(60), at(75), at(89)])[0].pass, true);
});

test('an oversized Arabic caption fails measured layout (box measured in a real render)', () => {
  const huge = { y: -308, h: 1808, scrollH: 1808, clientH: 1808 };
  assert.equal(layoutFindings(timeline, [at(60, huge), at(75, huge), at(89, huge)])[0].pass, false);
});

test('clipped glyphs (content taller than its box) fail', () => {
  const clipped = { scrollH: 130, clientH: 128 };
  assert.equal(layoutFindings(timeline, [at(60), at(75, clipped), at(89)])[0].pass, false);
});

test('missing, unsized or malformed measurements fail rather than passing silently', () => {
  assert.equal(layoutFindings(timeline, [])[0].pass, false);
  assert.equal(layoutFindings(timeline, [at(60), at(75)])[0].pass, false);
  assert.equal(layoutFindings(timeline, [at(60, { w: 0, clientW: 0 }), at(75), at(89)])[0].pass, false);
  assert.equal(layoutFindings(timeline, [{ id: 't', frame: 60, w: 1, clientW: 1 }, at(75), at(89)])[0].pass, false);
});

test('the disclosure label is a measured item too', () => {
  const withDisclosure = { ...timeline, disclosure: { text: 'Demo' } };
  const ids = layoutFindings(withDisclosure, [at(60), at(75), at(89)]).map((f) => [f.id, f.pass]);
  assert.deepEqual(ids, [['t', true], ['disclosure', false]]);
});

test('restricted originals and symlink escapes are never deliverable', (t) => {
  const run = mkdtempSync(join(tmpdir(), 'mv-run-'));
  t.after(() => rmSync(run, { recursive: true, force: true }));
  ensureRestricted(run);
  assert.equal(readFileSync(join(run, 'restricted', '.gitignore'), 'utf8'), '*\n!.gitignore\n');
  writeFileSync(join(run, 'restricted', 'originals', 'raw.png'), 'secret');
  mkdirSync(join(run, 'assets'));
  writeFileSync(join(run, 'assets', 'ok.png'), 'fine');
  symlinkSync(join(run, 'restricted', 'originals', 'raw.png'), join(run, 'assets', 'link.png'));
  const outside = mkdtempSync(join(tmpdir(), 'mv-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'x.png'), 'x');
  symlinkSync(join(outside, 'x.png'), join(run, 'assets', 'escape.png'));
  assert.equal(deliverablePath(run, 'assets/ok.png').ok, true);
  assert.match(deliverablePath(run, 'restricted/originals/raw.png').reason, /restricted/);
  assert.match(deliverablePath(run, 'assets/link.png').reason, /restricted/);
  assert.match(deliverablePath(run, 'assets/escape.png').reason, /escapes/);
  assert.match(deliverablePath(run, 'restricted').reason, /restricted/);
  if (process.platform !== 'linux') assert.match(deliverablePath(run, 'Restricted/originals/raw.png').reason, /restricted/);
});

test('a symlinked assets/ directory cannot redirect run writes outside the run', (t) => {
  const run = mkdtempSync(join(tmpdir(), 'mv-run-'));
  const outside = mkdtempSync(join(tmpdir(), 'mv-outside-'));
  t.after(() => { rmSync(run, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  mkdirSync(join(run, 'exports'));
  assert.equal(runWritePath(run, join(run, 'exports'), 'r1'), join(run, 'exports', 'r1'));
  symlinkSync(outside, join(run, 'assets'));
  assert.throws(() => runWritePath(run, join(run, 'assets'), 'x.png'), /does not resolve inside the run/);
  assert.throws(() => runWritePath(run, join(run, 'exports'), '..', '..', 'x'), /outside/);
  // A symlinked parent: nothing may be created outside before the refusal.
  symlinkSync(outside, join(run, 'restricted'));
  assert.throws(() => runWritePath(run, join(run, 'restricted', 'originals'), 'x.png'), /does not resolve inside the run/);
  assert.throws(() => ensureRestricted(run), /does not resolve inside the run/);
  assert.equal(existsSync(join(outside, 'originals')), false);
});

test('a long mid-video silence in a voiced video fails; a short CTA tail passes', () => {
  // Measured on r7 (2026-10-25): voice missing on two shots.
  const r7 = [{ start: 2.338, end: 12.248 }, { start: 13.123, end: 15.445 }];
  assert.deepEqual(silenceFindings(r7, 15.445).map((g) => g.start), [2.338]);
  assert.deepEqual(silenceFindings([{ start: 5, end: 6.5 }, { start: 13.5, end: null }], 15.4), []);
  assert.equal(silenceFindings([{ start: 10, end: null }], 15.4).length, 1);
});
