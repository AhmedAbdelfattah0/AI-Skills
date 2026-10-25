// Revision identity. A shot is "unaffected" by a revision only when its own
// inputs are byte-identical AND every global input (composition code,
// dependency lock, brand, safe zone, render settings, frame geometry,
// disclosure) is unchanged. Any global change puts every shot in the closure.
import { sha256Json } from './run.mjs';

export function globalsDigest({ compositionDigest, lockDigest, renderSettings, project, timeline }) {
  return sha256Json({
    composition: compositionDigest, lock: lockDigest, brand: project.brand || {},
    safeZone: project.exportPresets?.[timeline.preset || 'reel']?.safeZone || {},
    render: renderSettings, frame: { fps: timeline.fps, width: timeline.width, height: timeline.height },
    disclosure: timeline.disclosure || null,
  });
}

export function shotHashes(timeline, manifest) {
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
