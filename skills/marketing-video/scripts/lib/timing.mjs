// Frame arithmetic shared by the gates, the verifier and the composition, so
// the three can never disagree about where a shot starts.

// A shot with transitionIn {type: 'crossfade', frames: n} starts n frames
// before the previous shot ends and fades in over it. The overlap never
// reaches into the shot before the previous one, so at most two shots blend.
export function shotSpans(timeline) {
  const spans = [];
  (timeline.shots || []).forEach((shot, i) => {
    const prev = spans[i - 1];
    let overlap = 0;
    if (prev && shot.transitionIn?.type === 'crossfade') {
      const n = Number.isInteger(shot.transitionIn.frames) ? shot.transitionIn.frames : 10;
      overlap = Math.max(0, Math.min(n, prev.end - prev.start - prev.overlapIn - 1, shot.durationFrames - 1));
    }
    const start = (prev ? prev.end : 0) - overlap;
    spans.push({ id: shot.id, start, end: start + shot.durationFrames, overlapIn: overlap });
  });
  return spans;
}

export function totalFrames(timeline) {
  const spans = shotSpans(timeline);
  return spans.length ? spans[spans.length - 1].end : 0;
}

export function voiceFrames(asset, fps) {
  return Math.ceil((asset?.media?.durationSec || 0) * fps);
}
