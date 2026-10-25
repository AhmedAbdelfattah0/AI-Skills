// Frame arithmetic shared by the gates, the verifier and the composition, so
// the three can never disagree about where a shot starts.

export function shotSpans(timeline) {
  let start = 0;
  return (timeline.shots || []).map((shot) => {
    const span = { id: shot.id, start, end: start + shot.durationFrames };
    start = span.end;
    return span;
  });
}

export function totalFrames(timeline) {
  return (timeline.shots || []).reduce((sum, shot) => sum + (shot.durationFrames || 0), 0);
}

export function voiceFrames(asset, fps) {
  return Math.ceil((asset?.media?.durationSec || 0) * fps);
}
