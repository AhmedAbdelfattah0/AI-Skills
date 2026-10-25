// Revision identity. A shot is "unaffected" by a revision only when its own
// inputs are byte-identical AND every global input (composition code,
// dependency lock, brand, safe zone, render settings, frame geometry,
// disclosure) is unchanged. Any global change puts every shot in the closure.
import { sha256Json } from './run.mjs';
import { shotSpans } from './timing.mjs';

// Music plays under every shot, so the music and its bytes are global inputs.
// Music is one continuous track whose gain depends on every voice window and
// on the video's length, so that schedule is global too: any change to it
// puts every shot in the affected closure.
export function globalsDigest({ compositionDigest, lockDigest, renderSettings, project, timeline, musicSha256 = null, musicSchedule = null }) {
  return sha256Json({
    composition: compositionDigest, lock: lockDigest, brand: project.brand || {},
    safeZone: project.exportPresets?.[timeline.preset || 'reel']?.safeZone || {},
    render: renderSettings, frame: { fps: timeline.fps, width: timeline.width, height: timeline.height },
    disclosure: timeline.disclosure || null, music: timeline.music ? { ...timeline.music, sha256: musicSha256, schedule: musicSchedule } : null,
  });
}

// A crossfade blends two neighbouring shots, so each of them depends on the
// other's inputs: a change to either puts both in the affected closure.
export function shotHashes(timeline, manifest) {
  const own = ownShotHashes(timeline, manifest);
  const shots = timeline.shots || [];
  // Resolved crossfade lengths depend on neighbours' durations, so the
  // geometry each shot actually renders with is part of its identity.
  const spans = shotSpans(timeline);
  // With music, a shot's sound also depends on where it sits on the music's
  // timeline, so its absolute start is part of its identity.
  shots.forEach((shot, i) => { own[shot.id] = sha256Json({ own: own[shot.id], overlapIn: spans[i].overlapIn, overlapOut: spans[i + 1]?.overlapIn || 0, musicAt: timeline.music ? spans[i].start : null }); });
  const out = {};
  shots.forEach((shot, i) => {
    const prev = i > 0 && shot.transitionIn?.type === 'crossfade' ? own[shots[i - 1].id] : null;
    const next = shots[i + 1]?.transitionIn?.type === 'crossfade' ? own[shots[i + 1].id] : null;
    out[shot.id] = prev || next ? sha256Json({ own: own[shot.id], prev, next }) : own[shot.id];
  });
  return out;
}

function ownShotHashes(timeline, manifest) {
  const assets = new Map((manifest.assets || []).map((a) => [a.id, a]));
  const out = {};
  for (const shot of timeline.shots || []) {
    out[shot.id] = sha256Json({
      shot,
      asset: shot.assetId ? assets.get(shot.assetId)?.sha256 ?? null : null,
      text: (timeline.text || []).filter((t) => t.shotId === shot.id),
      voice: (timeline.voice || []).filter((v) => v.shotId === shot.id).map((v) => ({ ...v, sha: assets.get(v.assetId)?.sha256 ?? null })),
    });
  }
  return out;
}

export function classifyShots(from, to) {
  const globalsChanged = from.globalsDigest !== to.globalsDigest;
  const ids = [...new Set([...Object.keys(from.shotHashes), ...Object.keys(to.shotHashes)])];
  return {
    globalsChanged,
    shots: ids.map((id) => {
      const inBoth = id in from.shotHashes && id in to.shotHashes;
      const same = inBoth && !globalsChanged && from.shotHashes[id] === to.shotHashes[id];
      const reason = !inBoth ? (id in from.shotHashes ? 'removed' : 'added')
        : globalsChanged ? 'global inputs changed' : same ? 'inputs identical' : 'shot inputs changed';
      return { id, inBoth, affected: !same, reason };
    }),
  };
}
