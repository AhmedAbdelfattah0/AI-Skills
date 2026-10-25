import React from 'react';
import { AbsoluteFill, Composition, Img, OffthreadVideo, registerRoot, staticFile } from 'remotion';
import { Video } from './Video.jsx';
import { totalFrames } from '../lib/timing.mjs';

// Sanitize bakes opaque masks into a derivative still. Masks are applied to
// the asset itself, never only at final render, so the editable package and
// reviewer evidence never carry the unmasked pixels.
// Masks are static for the whole clip: right for fixed UI chrome (browser
// bars, account menus); moving content needs a re-capture instead.
// An optional crop (in source pixels) keeps only the app window, so a
// full-screen recording frames like a screenshot of the same page.
const Masked = ({ file, boxes = [], video = false, width, height, crop }) => {
  const c = crop || { x: 0, y: 0, w: width, h: height };
  const media = { position: 'absolute', left: -c.x, top: -c.y, width, height };
  return (
    <AbsoluteFill style={{ overflow: 'hidden' }}>
      {video ? <OffthreadVideo src={staticFile(file)} muted style={media} /> : <Img src={staticFile(file)} style={media} />}
      {boxes.map((b, i) => <div key={i} style={{ position: 'absolute', left: b.x - c.x, top: b.y - c.y, width: b.w, height: b.h, background: b.color || '#1f2329' }} />)}
    </AbsoluteFill>
  );
};

// One generic, props-driven composition. Everything run-specific arrives as
// input props built from timeline.json, so the editable source of a video is
// its timeline, not a per-run copy of this code.
const Root = () => (
  <>
  <Composition
    id="Sanitize"
    component={Masked}
    durationInFrames={1}
    fps={30}
    width={100}
    height={100}
    defaultProps={{ file: '', width: 100, height: 100, boxes: [] }}
    calculateMetadata={({ props }) => ({ width: props.crop?.w || props.width, height: props.crop?.h || props.height })}
  />
  <Composition
    id="SanitizeVideo"
    component={Masked}
    durationInFrames={1}
    fps={30}
    width={100}
    height={100}
    defaultProps={{ file: '', width: 100, height: 100, boxes: [], video: true, durationSec: 1 }}
    calculateMetadata={({ props }) => ({ width: props.crop?.w || props.width, height: props.crop?.h || props.height, durationInFrames: Math.max(1, Math.floor(props.durationSec * 30)) })}
  />
  <Composition
    id="MarketingVideo"
    component={Video}
    durationInFrames={1}
    fps={30}
    width={1080}
    height={1920}
    defaultProps={{ timeline: { shots: [], fps: 30, width: 1080, height: 1920 }, assets: {}, brand: {}, safeZone: {} }}
    calculateMetadata={({ props }) => ({
      durationInFrames: Math.max(1, totalFrames(props.timeline)),
      fps: props.timeline.fps,
      width: props.timeline.width,
      height: props.timeline.height,
    })}
  />
  </>
);

registerRoot(Root);
