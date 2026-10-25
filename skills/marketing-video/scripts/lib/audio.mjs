// Background-music level, shared by the composition (which plays it) and QA
// (which measures the voice against it). Music ducks under every voice line,
// with a short ramp either side, and fades in at the start and out at the end.
import { shotSpans, totalFrames, voiceFrames } from './timing.mjs';

export const MUSIC_DEFAULTS = { volume: 0.3, duckVolume: 0.08, rampFrames: 8, fadeInFrames: 15, fadeOutFrames: 30 };

// durations: { assetId: seconds }
export function voiceWindows(timeline, durations) {
  const starts = new Map(shotSpans(timeline).map((s) => [s.id, s.start]));
  return (timeline.voice || [])
    .filter((v) => starts.has(v.shotId) && durations[v.assetId])
    .map((v) => {
      const s = starts.get(v.shotId) + (v.startFrame || 0);
      return [s, s + voiceFrames({ media: { durationSec: durations[v.assetId] } }, timeline.fps)];
    });
}

export function musicVolume(frame, timeline, windows) {
  const m = { ...MUSIC_DEFAULTS, ...(timeline.music || {}) };
  const total = totalFrames(timeline);
  let distance = Infinity;
  for (const [s, e] of windows) distance = Math.min(distance, frame < s ? s - frame : frame > e ? frame - e : 0);
  const t = Math.min(1, distance / Math.max(1, m.rampFrames));
  const level = m.duckVolume + (m.volume - m.duckVolume) * t;
  const fadeIn = Math.min(1, frame / Math.max(1, m.fadeInFrames));
  const fadeOut = Math.min(1, (total - 1 - frame) / Math.max(1, m.fadeOutFrames));
  return Math.max(0, level * Math.min(fadeIn, fadeOut));
}
