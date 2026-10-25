// Pure QA helpers: which frames become review evidence, and whether the
// measured text boxes stay inside the platform safe zone.
import { shotSpans, totalFrames } from './timing.mjs';

// In a voiced video a long silent stretch reads as broken audio. Silence is
// allowed only at the very end (the CTA hold), up to tailSec.
export function silenceFindings(intervals, totalSec, { maxGapSec = 2.0, tailSec = 3.0 } = {}) {
  return intervals
    .map((i) => ({ start: i.start, end: i.end ?? totalSec }))
    .filter((i) => {
      const atEnd = i.end >= totalSec - 0.1;
      return atEnd ? i.end - i.start > tailSec : i.end - i.start > maxGapSec;
    });
}

export const DEFAULT_SAFE_ZONE = { top: 220, bottom: 380, left: 64, right: 64 };

// ffmpeg's accurate seek returns the first frame whose pts >= t. Seeking just
// before frame n's pts returns frame n, including the very last frame.
export function frameTime(frame, fps) {
  return Math.max(0, frame / fps - 0.0005);
}

export function evidenceFrames(timeline) {
  const spans = shotSpans(timeline);
  const total = totalFrames(timeline);
  const want = new Map();
  const add = (f, why, shotId) => { if (f >= 0 && f < total && !want.has(f)) want.set(f, { frame: f, why, shotId }); };
  spans.forEach((s, i) => {
    add(s.start, 'shot-first', s.id);
    add(Math.floor((s.start + s.end - 1) / 2), 'shot-mid', s.id);
    add(s.end - 1, 'shot-last', s.id);
    if (i > 0) { add(s.start - 2, 'boundary', spans[i - 1].id); add(s.start + 2, 'boundary', s.id); }
    if (s.overlapIn > 0) add(s.start + Math.floor(s.overlapIn / 2), 'crossfade-mid', s.id);
  });
  const startOf = new Map(spans.map((s) => [s.id, s.start]));
  for (const t of timeline.text || []) add(startOf.get(t.shotId) + t.startFrame + 6, `text-visible:${t.id}`, t.shotId);
  return [...want.values()].sort((a, b) => a.frame - b.frame);
}

// Every rendered string — text items, the disclosure, AI-generated labels —
// must report a complete, finite, laid-out measurement at each of its probe
// frames (first, middle, last). A missing or malformed measurement fails.
export function expectedMeasurements(timeline, assetKinds = {}) {
  const spans = new Map(shotSpans(timeline).map((s) => [s.id, s]));
  const probes = (start, len) => [...new Set([start, start + Math.floor(len / 2), start + len - 1])];
  const out = (timeline.text || []).filter((t) => spans.has(t.shotId)).map((t) => ({ id: t.id, frames: probes(spans.get(t.shotId).start + t.startFrame, t.endFrame - t.startFrame) }));
  if (timeline.disclosure?.text) out.push({ id: 'disclosure', frames: probes(0, totalFrames(timeline)) });
  for (const shot of timeline.shots || []) {
    if (assetKinds[shot.assetId] === 'generated') out.push({ id: `label-generated:${shot.id}`, frames: probes(spans.get(shot.id).start, shot.durationFrames) });
  }
  return out;
}

const FIELDS = ['frame', 'x', 'y', 'w', 'h', 'scrollW', 'clientW', 'scrollH', 'clientH'];

export function layoutFindings(timeline, layout, safeZone = {}, assetKinds = {}) {
  const zone = { ...DEFAULT_SAFE_ZONE, ...safeZone };
  return expectedMeasurements(timeline, assetKinds).map(({ id, frames }) => {
    const valid = layout.filter((l) => l.id === id && FIELDS.every((k) => Number.isFinite(l[k])) && l.w > 0 && l.h > 0 && l.clientW > 0);
    const missing = frames.filter((f) => !valid.some((l) => l.frame === f));
    if (missing.length) return { id, pass: false, detail: `no valid measurement at frame(s) ${missing.join(',')}; containment unknown` };
    const bad = valid.filter((r) => r.x < zone.left - 1 || r.x + r.w > timeline.width - zone.right + 1 || r.y < zone.top - 1
      || r.y + r.h > timeline.height - zone.bottom + 1 || r.scrollW > r.clientW + 1 || r.scrollH > r.clientH + 1);
    return bad.length
      ? { id, pass: false, detail: `outside safe zone or overflowing at frames ${bad.map((b) => b.frame).join(',')}: ${JSON.stringify(bad[0])}` }
      : { id, pass: true, detail: `measured at frames ${frames.join(',')}: inside the safe zone, no overflow` };
  });
}
