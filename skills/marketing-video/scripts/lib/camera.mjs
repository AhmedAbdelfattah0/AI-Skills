// Camera geometry shared by the composition and the framing gate, so the gate
// checks exactly the crop the renderer will draw.

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

// Scale 1 covers the frame. `fit: true` shows the whole asset (letterboxed),
// the natural opening for a desktop screen in a vertical video, so a zoom
// into a detail is always seen as a move, never a cut to an already-cropped
// view.
// The whole asset fits inside the side safe margins (FIT_INSET each side),
// so nothing at its edges sits under the platform's UI.
export const FIT_INSET = 64;
export function fitScale(asset, W, H) {
  return Math.min((W - 2 * FIT_INSET) / asset.width, H / asset.height) / Math.max(W / asset.width, H / asset.height);
}

export function cameraEnds(shot, asset, W, H) {
  const resolve = (p) => (p.fit && asset ? { ...p, scale: fitScale(asset, W, H) } : p);
  const from = resolve({ scale: 1, cx: 0.5, cy: 0.5, ...(shot.camera?.from || {}) });
  const to = resolve({ ...from, fit: false, ...(shot.camera?.to || {}) });
  return { from, to };
}

// The move runs over camera.moveFrames (default: the whole shot) and then
// holds, so the end framing can be reached before the line about it plays.
// Scale is interpolated geometrically, so a zoom feels even all the way in.
export function camAt(shot, frame, asset, W, H) {
  const { from, to } = cameraEnds(shot, asset, W, H);
  const span = Math.max(1, Math.min(shot.camera?.moveFrames || shot.durationFrames, shot.durationFrames) - 1);
  const t = easeInOutCubic(Math.min(1, Math.max(0, frame / span)));
  return { scale: from.scale * (to.scale / from.scale) ** t, cx: from.cx + (to.cx - from.cx) * t, cy: from.cy + (to.cy - from.cy) * t };
}

// Cover the frame with the asset, zoom by `scale` and keep the normalized
// focus point (cx, cy) as close to the frame centre as the edges allow. Below
// cover the asset is centred on the axis it no longer fills.
export function cameraBox(asset, W, H, cam) {
  const cover = Math.max(W / asset.width, H / asset.height);
  const k = cover * Math.max(cam.scale, fitScale(asset, W, H));
  const dw = asset.width * k;
  const dh = asset.height * k;
  const left = dw <= W ? (W - dw) / 2 : Math.min(0, Math.max(W - dw, W / 2 - cam.cx * dw));
  const top = dh <= H ? (H - dh) / 2 : Math.min(0, Math.max(H - dh, H / 2 - cam.cy * dh));
  return { left, top, k, dw, dh, letterboxed: dw < W - 0.5 || dh < H - 0.5 };
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
