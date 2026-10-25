// Camera geometry shared by the composition and the framing gate, so the gate
// checks exactly the crop the renderer will draw.

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export function cameraEnds(shot) {
  const from = { scale: 1, cx: 0.5, cy: 0.5, ...(shot.camera?.from || {}) };
  const to = { ...from, ...(shot.camera?.to || {}) };
  return { from, to };
}

// The move runs over camera.moveFrames (default: the whole shot) and then
// holds, so the end framing can be reached before the line about it plays.
export function camAt(shot, frame) {
  const { from, to } = cameraEnds(shot);
  const span = Math.max(1, Math.min(shot.camera?.moveFrames || shot.durationFrames, shot.durationFrames) - 1);
  const t = easeInOutCubic(Math.min(1, Math.max(0, frame / span)));
  return { scale: from.scale + (to.scale - from.scale) * t, cx: from.cx + (to.cx - from.cx) * t, cy: from.cy + (to.cy - from.cy) * t };
}

// Cover the frame with the asset, zoom by `scale` and keep the normalized
// focus point (cx, cy) as close to the frame centre as the edges allow.
export function cameraBox(asset, W, H, cam) {
  const cover = Math.max(W / asset.width, H / asset.height);
  const k = cover * cam.scale;
  const dw = asset.width * k;
  const dh = asset.height * k;
  const left = Math.min(0, Math.max(W - dw, W / 2 - cam.cx * dw));
  const top = Math.min(0, Math.max(H - dh, H / 2 - cam.cy * dh));
  return { left, top, k, dw, dh };
}

// Bands of the frame a highlighted target must stay clear of: the platform
// safe zone, the caption band when the shot has captions, and the label band
// where the disclosure sits. Shared by the framing gate and the composition.
// A two-line caption box: 40 px above the safe zone plus 2 × 84 px lines and padding.
export const CAPTION_BAND = 260;
export const LABEL_BAND = 80;

export function contentArea(timeline, zone, { hasCaption = false } = {}) {
  const top = zone.top + (timeline.disclosure?.text && timeline.disclosure.position !== 'bottom' ? LABEL_BAND : 0);
  const bottomBands = (hasCaption ? CAPTION_BAND : 0) + (timeline.disclosure?.text && timeline.disclosure.position === 'bottom' ? LABEL_BAND : 0);
  return { left: zone.left, right: timeline.width - zone.right, top, bottom: timeline.height - zone.bottom - bottomBands };
}

// Where an asset-pixel rectangle lands on screen for a camera position.
export function onScreen(rect, box) {
  return { x: box.left + rect.x * box.k, y: box.top + rect.y * box.k, w: rect.w * box.k, h: rect.h * box.k };
}
