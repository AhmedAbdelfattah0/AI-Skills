// Run gates: truthfulness, privacy, cost, rights and timing. Each negative
// case starts from a baseline that passes, so a failure can only come from
// the one field the case changes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkRun } from './lib/gates.mjs';

const SHA = 'a'.repeat(64);

function baseline() {
  return {
    project: { prohibitedClaims: ['guaranteed'], toolRights: { remotion: { commercialUse: 'yes' } }, disclosureLabels: ['Demo', 'Results guaranteed'] },
    manifest: {
      assets: [
        { id: 'shot', kind: 'screenshot', captureMethod: 'screenshot', file: 'assets/shot.png', sha256: SHA, media: { width: 1080, height: 1920 }, rights: { commercialUse: 'yes' }, sensitivity: { status: 'clean', reviewedSha256: SHA }, provenance: { cost: { amount: 0, unit: 'USD' } } },
        { id: 'vo', kind: 'voice', captureMethod: 'tts', file: 'assets/vo.wav', sha256: SHA, media: { durationSec: 2 }, rights: { commercialUse: 'yes' }, sensitivity: { status: 'clean', reviewedSha256: SHA }, provenance: { provider: 'local:say', text: 'كل منتجاتك في جدول', cost: { amount: 0, unit: 'USD' } } },
      ],
    },
    claims: { claims: [{ id: 'c1', text: 'Products are listed in a table', status: 'verified', evidence: [{ type: 'asset', ref: 'shot', sha256: SHA, region: { x: 0, y: 0, w: 100, h: 100 }, excerpt: 'table of products' }] }] },
    approvals: { approvals: [] },
    timeline: {
      fps: 30, width: 1080, height: 1920,
      shots: [{ id: 's1', assetId: 'shot', durationFrames: 90, highlight: { x: 300, y: 800, w: 400, h: 100 } }, { id: 's2', assetId: null, card: {}, durationFrames: 60 }],
      text: [
        { id: 't1', shotId: 's1', kind: 'caption', lang: 'ar', text: 'كل منتجاتك في جدول', class: 'factual', claimId: 'c1', startFrame: 0, endFrame: 60 },
        { id: 't2', shotId: 's2', kind: 'overlay', lang: 'ar', text: 'جرّبها الآن', class: 'cta', startFrame: 0, endFrame: 60 },
      ],
      voice: [{ id: 'v1', shotId: 's1', assetId: 'vo', startFrame: 6, class: 'factual', claimId: 'c1', text: 'كل منتجاتك في جدول' }],
    },
    fileInfo: () => ({ deliverable: true, sha256: SHA }),
  };
}

const gatesOf = (input) => checkRun(input).findings.map((f) => `${f.severity}:${f.gate}`);

test('the baseline passes and is final-eligible', () => {
  const r = checkRun(baseline());
  assert.deepEqual(r.findings, []);
  assert.equal(r.status, 'pass');
  assert.equal(r.deliveryStatus, 'final-eligible');
});

test('factual text without a claim blocks', () => {
  const input = baseline();
  delete input.timeline.text[0].claimId;
  assert.deepEqual(gatesOf(input), ['block:MV-CLAIM']);
});

test('an unverified claim blocks both the caption and the voice line that cite it', () => {
  const input = baseline();
  input.claims.claims[0].status = 'unverified';
  assert.deepEqual(gatesOf(input), ['block:MV-CLAIM', 'block:MV-CLAIM']);
});

test('a prohibited claim blocks even when classified as cta', () => {
  const input = baseline();
  input.timeline.text[1].text = 'Results guaranteed';
  assert.deepEqual(gatesOf(input), ['block:MV-PROHIBITED']);
});

test('unclassified text blocks', () => {
  const input = baseline();
  delete input.timeline.text[1].class;
  assert.deepEqual(gatesOf(input), ['block:MV-TRUTH-CLASS']);
});

test('conceptual text on a real screenshot blocks; on a card it is allowed', () => {
  const onShot = baseline();
  Object.assign(onShot.timeline.text[0], { class: 'conceptual' });
  delete onShot.timeline.text[0].claimId;
  assert.deepEqual(gatesOf(onShot), ['block:MV-CONCEPT']);
  const onCard = baseline();
  onCard.timeline.text[1].class = 'conceptual';
  assert.deepEqual(gatesOf(onCard), []);
});

test('a synthetic cursor or click on a shot blocks', () => {
  for (const field of ['interaction', 'cursor', 'click']) {
    const input = baseline();
    input.timeline.shots[0][field] = { x: 1, y: 1 };
    assert.deepEqual(gatesOf(input), ['block:MV-TRUTH-INTERACTION'], field);
  }
});

test('an unreviewed or sensitive asset blocks (sensitive-data negative scenario)', () => {
  for (const status of [undefined, 'unreviewed', 'contains-sensitive']) {
    const input = baseline();
    input.manifest.assets[0].sensitivity = { status, reviewedSha256: SHA };
    assert.deepEqual(gatesOf(input), ['block:MV-PRIV'], String(status));
  }
});

test('a privacy review of different bytes blocks', () => {
  const input = baseline();
  input.manifest.assets[0].sensitivity.reviewedSha256 = 'b'.repeat(64);
  assert.deepEqual(gatesOf(input), ['block:MV-PRIV']);
});

test('a restricted or changed asset file blocks', () => {
  const restricted = baseline();
  restricted.fileInfo = (f) => (f === 'assets/shot.png' ? { deliverable: false, reason: 'restricted original' } : { deliverable: true, sha256: SHA });
  assert.deepEqual(gatesOf(restricted), ['block:MV-RESTRICTED']);
  const changed = baseline();
  changed.fileInfo = (f) => ({ deliverable: true, sha256: f === 'assets/shot.png' ? 'c'.repeat(64) : SHA });
  assert.deepEqual(gatesOf(changed), ['block:MV-ASSET-HASH']);
});

test('spend needs a live user approval for that provider and unit, within its cap', () => {
  const input = baseline();
  input.manifest.assets[0].provenance = { provider: 'gen-x', cost: { amount: 5, unit: 'credits' }, approvalId: 'ap1' };
  assert.deepEqual(gatesOf(input), ['block:MV-COST']);
  const ok = { id: 'ap1', type: 'spend', decidedBy: 'user', status: 'active', provider: 'gen-x', unit: 'credits', cap: 10, consumed: 0 };
  input.approvals.approvals = [ok];
  assert.deepEqual(gatesOf(input), []);
  for (const bad of [{ decidedBy: 'agent' }, { type: 'final-video' }, { status: 'closed' }, { provider: 'other' }, { unit: 'USD' }, { cap: 4 }, { expires: '2000-01-01T00:00:00Z' }, { reserved: 6 }]) {
    input.approvals.approvals = [{ ...ok, ...bad }];
    assert.deepEqual(gatesOf(input), ['block:MV-COST'], JSON.stringify(bad));
  }
});

test('costs charged to one approval are summed against its cap', () => {
  const input = baseline();
  input.manifest.assets[0].provenance = { provider: 'gen-x', cost: { amount: 6, unit: 'credits' }, approvalId: 'ap1' };
  input.manifest.assets.push({ ...input.manifest.assets[0], id: 'shot2', provenance: { provider: 'gen-x', cost: { amount: 6, unit: 'credits' }, approvalId: 'ap1' } });
  input.approvals.approvals = [{ id: 'ap1', type: 'spend', decidedBy: 'user', status: 'active', provider: 'gen-x', unit: 'credits', cap: 10, consumed: 0 }];
  assert.deepEqual(gatesOf(input), ['block:MV-COST']);
});

test('an approval awaiting reconciliation blocks further work', () => {
  const input = baseline();
  input.approvals.approvals.push({ id: 'ap2', type: 'spend', decidedBy: 'user', provider: 'p', unit: 'USD', cap: 1, consumed: 0, status: 'needs-reconciliation' });
  assert.deepEqual(gatesOf(input), ['block:MV-COST']);
});

test('unknown rights make the output a draft, never final (unavailable-provider negative scenario)', () => {
  const input = baseline();
  input.manifest.assets[1].rights.commercialUse = 'unknown';
  input.project.toolRights = {};
  const r = checkRun(input);
  assert.equal(r.status, 'pass');
  assert.equal(r.deliveryStatus, 'draft');
  assert.deepEqual(r.findings.map((f) => f.gate), ['MV-RIGHTS', 'MV-RIGHTS']);
});

test('voice longer than its shot blocks', () => {
  const input = baseline();
  input.manifest.assets[1].media.durationSec = 2.9;
  // The overrunning line also outlasts its caption, which is reported too.
  assert.deepEqual(gatesOf(input), ['block:MV-TIMING', 'block:MV-CAPTIONS']);
});

test('captions that overlap, run past the shot or flash too briefly block', () => {
  const overlap = baseline();
  overlap.timeline.text.push({ id: 't3', shotId: 's1', kind: 'caption', lang: 'ar', text: 'x', class: 'neutral', startFrame: 30, endFrame: 89 });
  assert.deepEqual(gatesOf(overlap), ['block:MV-TIMING']);
  const outside = baseline();
  outside.timeline.text[0].endFrame = 91;
  assert.ok(gatesOf(outside).includes('block:MV-TIMING'));
  const brief = baseline();
  brief.timeline.text[0].endFrame = 20;
  assert.ok(gatesOf(brief).includes('block:MV-TIMING'));
});

test('claim evidence must resolve to a manifest asset with matching bytes and an excerpt', () => {
  for (const evidence of [[{}], [{ type: 'asset', ref: 'missing', sha256: SHA, excerpt: 'x' }], [{ type: 'asset', ref: 'shot', sha256: 'b'.repeat(64), excerpt: 'x' }], [{ type: 'asset', ref: 'shot', sha256: SHA }], [{ type: 'doc', ref: 'https://x', excerpt: 'short' }], [{ type: 'user', excerpt: 'said so' }]]) {
    const input = baseline();
    input.claims.claims[0].evidence = evidence;
    assert.ok(gatesOf(input).includes('block:MV-CLAIM'), JSON.stringify(evidence));
  }
});

test('a voice line whose audio says something else blocks', () => {
  const input = baseline();
  input.manifest.assets[1].provenance.text = 'نص مختلف تماماً';
  assert.deepEqual(gatesOf(input), ['block:MV-VOICE-TEXT']);
});

test('spoken words without a caption or overlay showing them block', () => {
  const input = baseline();
  input.timeline.text = input.timeline.text.filter((t) => t.id !== 't1');
  assert.deepEqual(gatesOf(input), ['block:MV-CAPTIONS']);
});

test('the disclosure must be an approved label, short and free of prohibited claims', () => {
  const input = baseline();
  input.timeline.disclosure = { text: 'Results guaranteed' };
  assert.deepEqual(gatesOf(input), ['block:MV-PROHIBITED']);
  input.timeline.disclosure = { text: 'Revenue doubles with this product' };
  assert.deepEqual(gatesOf(input), ['block:MV-DISCLOSURE']);
  input.timeline.disclosure = { text: 'x'.repeat(61) };
  assert.deepEqual(gatesOf(input), ['block:MV-DISCLOSURE']);
});

test('evidence regions must be positive rectangles and times must fall inside a recording', () => {
  for (const patch of [{ region: { x: 10, y: 10, w: -5, h: 20 } }, { region: { x: 10, y: 10, w: 0, h: 20 } }, { time: 3 }]) {
    const input = baseline();
    Object.assign(input.claims.claims[0].evidence[0], patch);
    assert.ok(gatesOf(input).includes('block:MV-CLAIM'), JSON.stringify(patch));
  }
});

test('negative or malformed approval numbers and dates block', () => {
  const live = { id: 'ap1', type: 'spend', decidedBy: 'user', status: 'active', provider: 'gen-x', unit: 'credits', cap: 1, consumed: 0 };
  for (const bad of [{ reserved: -100 }, { consumed: -1 }, { cap: Number.NaN }, { expires: 'not a date' }]) {
    const input = baseline();
    input.manifest.assets[0].provenance = { provider: 'gen-x', cost: { amount: 1, unit: 'credits' }, approvalId: 'ap1' };
    input.approvals.approvals = [{ ...live, ...bad }];
    assert.ok(gatesOf(input).includes('block:MV-COST'), JSON.stringify(bad));
  }
});

test('a caption that covers only part of the spoken line blocks', () => {
  const input = baseline();
  Object.assign(input.timeline.text[0], { startFrame: 50, endFrame: 89 });
  assert.deepEqual(gatesOf(input), ['block:MV-CAPTIONS']);
});

test('framing is checked from the first caption or voice frame, not only once the highlight appears', () => {
  const input = baseline();
  // The target sits under the top safe band until the move ends at frame 30;
  // the caption naming it starts at frame 0.
  Object.assign(input.timeline.shots[0], { highlight: { x: 796, y: 96, w: 244, h: 71 }, camera: { from: { scale: 1, cx: 0.5, cy: 0.3 }, to: { scale: 2.35, cx: 0.8, cy: 0.07 }, moveFrames: 30 } });
  assert.deepEqual(gatesOf(input), ['block:MV-FRAMING']);
});

test('asset kind must match its capture method; generated needs a provider', () => {
  const relabeled = baseline();
  relabeled.manifest.assets[0].kind = 'logo';
  assert.deepEqual(gatesOf(relabeled), ['block:MV-KIND']);
  const generated = baseline();
  Object.assign(generated.manifest.assets[0], { kind: 'generated', captureMethod: 'generated' });
  assert.deepEqual(gatesOf(generated), ['block:MV-KIND']);
  const bogus = baseline();
  bogus.manifest.assets[0].kind = 'anything';
  assert.ok(gatesOf(bogus).includes('block:MV-KIND'));
});

test('a camera that cuts off the highlighted target blocks; a framing that keeps it passes', () => {
  const input = baseline();
  Object.assign(input.timeline.shots[0], { highlight: { x: 796, y: 96, w: 244, h: 71 }, camera: { from: { scale: 1.6, cx: 0.5, cy: 0.3 }, to: { scale: 2.4, cx: 0.85, cy: 0.07 } } });
  assert.deepEqual(gatesOf(input), ['block:MV-FRAMING']);
  // 2.2x keeps the button on screen but inside the platform's top safe band.
  input.timeline.shots[0].camera = { from: { scale: 1, cx: 0.5, cy: 0.3 }, to: { scale: 2.2, cx: 0.8, cy: 0.07 }, moveFrames: 15 };
  assert.deepEqual(gatesOf(input), ['block:MV-FRAMING']);
  // Already framed when its caption starts at frame 0.
  input.timeline.shots[0].camera = { from: { scale: 2.35, cx: 0.8, cy: 0.07 }, to: { scale: 2.35, cx: 0.8, cy: 0.07 } };
  assert.deepEqual(gatesOf(input), []);
  input.timeline.disclosure = { text: 'Demo' };
  assert.deepEqual(gatesOf(input), ['block:MV-FRAMING'], 'a top disclosure covers the target');
  input.timeline.disclosure.position = 'bottom';
  assert.deepEqual(gatesOf(input), []);
});

test('a highlight outside the asset blocks', () => {
  const input = baseline();
  input.timeline.shots[0].highlight = { x: 1000, y: 10, w: 200, h: 50 };
  assert.deepEqual(gatesOf(input), ['block:MV-SCHEMA']);
});

test('crossfades: lines may not overlap; the first shot cannot crossfade; unknown transitions block', () => {
  const input = baseline();
  input.timeline.shots[1].transitionIn = { type: 'crossfade', frames: 10 };
  assert.deepEqual(gatesOf(input), ['block:MV-TIMING'], 'overlay t2 starts inside the crossfade');
  input.timeline.text[1].startFrame = 10;
  assert.deepEqual(gatesOf(input), []);
  input.manifest.assets.push({ ...input.manifest.assets[1], id: 'vo2', media: { durationSec: 1 }, provenance: { ...input.manifest.assets[1].provenance, text: 'جرّبها الآن' } });
  input.timeline.voice.push({ id: 'v2', shotId: 's2', assetId: 'vo2', startFrame: 10, class: 'cta', text: 'جرّبها الآن' });
  // v1 plays frames 6–66; with a 10-frame crossfade s2 starts at 80, so no overlap.
  assert.deepEqual(gatesOf(input), []);
  // A 20-frame crossfade: text and voice of s2 that start inside it block.
  input.timeline.shots[1].transitionIn.frames = 20;
  assert.deepEqual(gatesOf(input), ['block:MV-TIMING', 'block:MV-TIMING']);
  input.timeline.text[1].startFrame = 20;
  input.timeline.voice[1].startFrame = 20;
  assert.deepEqual(gatesOf(input), []);
  // A 30-frame crossfade starts at frame 60 of s1, while v1 (6–66) still speaks.
  input.timeline.shots[1].transitionIn.frames = 30;
  input.timeline.text[1].startFrame = 30;
  input.timeline.voice[1].startFrame = 30;
  assert.deepEqual(gatesOf(input), ['block:MV-TIMING']);
  const first = baseline();
  first.timeline.shots[0].transitionIn = { type: 'crossfade', frames: 10 };
  assert.ok(gatesOf(first).includes('block:MV-SCHEMA'));
  const wipe = baseline();
  wipe.timeline.shots[1].transitionIn = { type: 'wipe' };
  assert.ok(gatesOf(wipe).includes('block:MV-SCHEMA'));
});

test('frames must be positive integers; kept recording audio may not overlap another track', () => {
  for (const frames of [0, -3, 2.5, 'bad']) {
    const input = baseline();
    input.timeline.text[1].startFrame = 20;
    input.timeline.shots[1].transitionIn = { type: 'crossfade', frames };
    assert.ok(gatesOf(input).includes('block:MV-SCHEMA'), String(frames));
  }
  const input = baseline();
  input.manifest.assets.push({ ...input.manifest.assets[0], id: 'rec', kind: 'recording', captureMethod: 'manual', audioPolicy: 'keep', media: { width: 1080, height: 1920, durationSec: 10, hasAudio: true } });
  input.timeline.shots[1] = { id: 's2', assetId: 'rec', durationFrames: 60 };
  input.timeline.text[1].class = 'cta';
  assert.ok(gatesOf(input).every((g) => g !== 'block:MV-TIMING'), 'cut: no overlap');
  input.timeline.shots[1].transitionIn = { type: 'crossfade', frames: 30 };
  input.timeline.text[1].startFrame = 30;
  assert.ok(gatesOf(input).includes('block:MV-TIMING'), 'v1 still plays while the recording audio starts');
});

test('a camera that cannot be computed is refused', () => {
  for (const camera of [{ from: { scale: 0 } }, { to: { scale: -1 } }, { to: { scale: 'x' } }, { to: { cx: 1.5 } }, { from: { fit: 'yes' } }, { moveFrames: 0 }, { from: null }]) {
    const input = baseline();
    input.timeline.shots[0].camera = camera;
    assert.ok(gatesOf(input).includes('block:MV-SCHEMA'), JSON.stringify(camera));
  }
});

test('the outgoing shot\'s words must be gone before a crossfade starts (no conceptual text over real pixels)', () => {
  const input = baseline();
  input.timeline.shots[1].transitionIn = { type: 'crossfade', frames: 20 };
  input.timeline.text[1].startFrame = 20;
  // The crossfade starts at frame 70 of s1; t1 ends at 60 and v1 at 66: fine.
  assert.deepEqual(gatesOf(input), []);
  input.timeline.text[0].endFrame = 75;
  assert.ok(gatesOf(input).includes('block:MV-TIMING'));
});

test('music must be a music asset with sane levels', () => {
  const input = baseline();
  input.manifest.assets.push({ ...input.manifest.assets[1], id: 'bed', kind: 'music', captureMethod: 'provided', provenance: { cost: { amount: 0, unit: 'USD' } } });
  input.timeline.music = { assetId: 'bed', volume: 0.3, duckVolume: 0.08 };
  assert.deepEqual(gatesOf(input), []);
  for (const music of [{ assetId: 'vo', volume: 0.3 }, { assetId: 'nope' }, { assetId: 'bed', volume: 2 }, { assetId: 'bed', volume: 0.1, duckVolume: 0.2 }, { assetId: 'bed', fadeInFrames: -1 }]) {
    const bad = baseline();
    bad.manifest.assets.push({ ...bad.manifest.assets[1], id: 'bed', kind: 'music', captureMethod: 'provided', provenance: { cost: { amount: 0, unit: 'USD' } } });
    bad.timeline.music = music;
    assert.ok(gatesOf(bad).some((g) => g === 'block:MV-REF' || g === 'block:MV-SCHEMA'), JSON.stringify(music));
  }
});

test('a placeholder asset keeps the delivery a draft', () => {
  const input = baseline();
  input.manifest.assets[0].provenance.placeholder = true;
  const r = checkRun(input);
  assert.equal(r.deliveryStatus, 'draft');
  assert.deepEqual(r.findings.map((f) => f.gate), ['MV-PLACEHOLDER']);
});

test('music levels are validated after defaults are applied', () => {
  const input = baseline();
  input.manifest.assets.push({ ...input.manifest.assets[1], id: 'bed', kind: 'music', captureMethod: 'provided', provenance: { cost: { amount: 0, unit: 'USD' } } });
  input.timeline.music = { assetId: 'bed', volume: 0.02 };
  assert.ok(gatesOf(input).includes('block:MV-SCHEMA'), 'default duckVolume 0.08 would be louder than 0.02');
});
