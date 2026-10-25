import React, { useLayoutEffect, useRef } from 'react';
import {
  AbsoluteFill, Audio, Img, OffthreadVideo, Sequence,
  continueRender, delayRender, interpolate, staticFile, useCurrentFrame,
} from 'remotion';
import { musicVolume, voiceWindows } from '../lib/audio.mjs';
import { CAPTION_BAND, camAt, cameraBox } from '../lib/camera.mjs';
import { shotSpans, totalFrames } from '../lib/timing.mjs';

const ARABIC_STACK = '"Geeza Pro", "Noto Sans Arabic", "Noto Naskh Arabic", Tahoma';

function font(brand) {
  return `${brand.fontFamily ? `${brand.fontFamily}, ` : ''}system-ui, -apple-system, "Segoe UI", ${ARABIC_STACK}, sans-serif`;
}

// Report an element's measured box after fonts load, at the given local
// frames. The very first frame can be laid out before the viewport is sized,
// so measuring waits (bounded) for a non-zero box. render.mjs collects the
// MV_LAYOUT lines; nothing is written from inside the browser.
function useMeasure(ref, id, frame, probes, absFrame) {
  useLayoutEffect(() => {
    if (!probes.includes(frame)) return undefined;
    const handle = delayRender(`measure ${id}`);
    let tries = 0;
    const measure = () => {
      const el = ref.current;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && tries < 30) { tries += 1; requestAnimationFrame(measure); return; }
      console.log(`MV_LAYOUT ${JSON.stringify({ id, frame: absFrame, x: r.x, y: r.y, w: r.width, h: r.height, scrollW: el.scrollWidth, clientW: el.clientWidth, scrollH: el.scrollHeight, clientH: el.clientHeight })}`);
      continueRender(handle);
    };
    document.fonts.ready.then(measure);
    return undefined;
  }, [frame]);
}

function Pill({ id, children, zone, brand, len, offset, lang, row = 0, bottom = false }) {
  const ref = useRef(null);
  const frame = useCurrentFrame();
  useMeasure(ref, id, frame, [0, Math.floor(len / 2), len - 1], offset + frame);
  return (
    <div style={{ position: 'absolute', ...(bottom ? { bottom: zone.bottom + CAPTION_BAND + 12 + row * 64 } : { top: zone.top + 10 + row * 64 }), left: zone.left, right: zone.right, display: 'flex', justifyContent: 'center' }}>
      <div ref={ref} lang={lang} dir={lang === 'ar' ? 'rtl' : 'ltr'} style={{ background: 'rgba(0,0,0,.72)', color: '#fff', fontFamily: font(brand), fontSize: 30, lineHeight: 1.5, fontWeight: 600, padding: '8px 22px', borderRadius: 999, whiteSpace: 'nowrap' }}>{children}</div>
    </div>
  );
}

function ShotVisual({ shot, asset, timeline, brand }) {
  const frame = useCurrentFrame();
  const { width: W, height: H } = timeline;
  if (!asset) {
    const bg = shot.card?.background === 'ink' ? (brand.colors?.ink || '#111318') : (brand.colors?.primary || '#4f46e5');
    return <AbsoluteFill style={{ background: bg }} />;
  }
  const box = cameraBox(asset, W, H, camAt(shot, frame, asset, W, H));
  const media = { position: 'absolute', left: box.left, top: box.top, width: box.dw, height: box.dh };
  // Letterboxed (whole screen visible): fill the bands with a blurred, dimmed
  // copy of the same pixels rather than flat black.
  const backdrop = { position: 'absolute', inset: -60, width: W + 120, height: H + 120, objectFit: 'cover', filter: 'blur(36px) brightness(0.45)' };
  const h = shot.highlight;
  const hIn = h ? interpolate(frame, [Math.round(shot.durationFrames * 0.2), Math.round(shot.durationFrames * 0.2) + 8], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) : 0;
  return (
    <AbsoluteFill style={{ background: '#000', overflow: 'hidden' }}>
      {box.letterboxed ? (asset.kind === 'recording'
        ? <OffthreadVideo src={staticFile(asset.file)} muted startFrom={shot.trimStartFrames || 0} style={backdrop} />
        : <Img src={staticFile(asset.file)} style={backdrop} />) : null}
      {asset.kind === 'recording'
        ? <OffthreadVideo src={staticFile(asset.file)} muted={asset.audioPolicy !== 'keep'} startFrom={shot.trimStartFrames || 0} style={media} />
        : <Img src={staticFile(asset.file)} style={media} />}
      {h ? (
        <div style={{
          position: 'absolute', opacity: hIn,
          left: box.left + h.x * box.k - 10, top: box.top + h.y * box.k - 10, width: h.w * box.k + 20, height: h.h * box.k + 20,
          border: `6px solid ${brand.colors?.accent || brand.colors?.primary || '#4f46e5'}`, borderRadius: 22,
          boxShadow: '0 0 0 9999px rgba(0,0,0,.35)',
        }} />
      ) : null}
    </AbsoluteFill>
  );
}

function Text({ item, brand, safeZone, shotStart }) {
  const ref = useRef(null);
  const frame = useCurrentFrame();
  const len = item.endFrame - item.startFrame;
  useMeasure(ref, item.id, frame, [0, Math.floor(len / 2), len - 1], shotStart + item.startFrame + frame);
  const fadeIn = interpolate(frame, [0, 6], [0, 1], { extrapolateRight: 'clamp' });
  const fadeOut = interpolate(frame, [len - 6, len], [1, 0], { extrapolateLeft: 'clamp' });
  const caption = item.kind === 'caption';
  const pos = item.position || (caption ? 'bottom' : 'top');
  const place = pos === 'bottom'
    ? { bottom: safeZone.bottom + 40 }
    : pos === 'center' ? { top: '50%', transform: `translateY(-50%) translateY(${(1 - fadeIn) * 20}px)` } : { top: safeZone.top + 150 };
  return (
    <div ref={ref} dir={item.dir || (item.lang === 'ar' ? 'rtl' : 'ltr')} lang={item.lang} style={{
      position: 'absolute', left: safeZone.left, right: safeZone.right, ...place,
      opacity: Math.min(fadeIn, fadeOut), overflow: 'hidden', textAlign: 'center', fontFamily: font(brand),
      color: '#fff', whiteSpace: 'pre-wrap', overflowWrap: 'break-word',
      ...(caption
        ? { fontSize: item.size || 56, lineHeight: item.lang === 'ar' ? 1.5 : 1.3, fontWeight: 600, background: 'rgba(10,12,18,.92)', padding: '22px 30px', borderRadius: 26 }
        : { fontSize: item.size || 84, lineHeight: item.lang === 'ar' ? 1.45 : 1.15, fontWeight: 800, textShadow: '0 4px 24px rgba(0,0,0,.45)' }),
    }}>
      {item.text}
      {item.class === 'conceptual' ? <div style={{ fontSize: 28, fontWeight: 600, opacity: 0.85, marginTop: 10 }}>Concept · not a product feature</div> : null}
    </div>
  );
}

export const Video = ({ timeline, assets, brand = {}, safeZone = {} }) => {
  const zone = { top: 220, bottom: 380, left: 64, right: 64, ...safeZone };
  const spans = new Map(shotSpans(timeline).map((s) => [s.id, s]));
  return (
    <AbsoluteFill style={{ background: '#000' }}>
      {timeline.shots.map((shot) => {
        const span = spans.get(shot.id);
        const asset = shot.assetId ? assets[shot.assetId] : null;
        // 'fade' fades in from black; 'crossfade' fades in over the previous
        // shot, which keeps rendering underneath for the overlap.
        const fade = shot.transitionIn?.type === 'fade' ? shot.transitionIn.frames ?? 8 : span.overlapIn;
        return (
          <Sequence key={shot.id} from={span.start} durationInFrames={shot.durationFrames} name={shot.id}>
            <FadeIn frames={fade}><ShotVisual shot={shot} asset={asset} timeline={timeline} brand={brand} /></FadeIn>
            {asset?.kind === 'generated' ? <Pill id={`label-generated:${shot.id}`} zone={zone} brand={brand} len={shot.durationFrames} offset={span.start} row={timeline.disclosure?.text && timeline.disclosure.position !== 'bottom' ? 1 : 0}>AI-generated scene</Pill> : null}
            {(timeline.text || []).filter((t) => t.shotId === shot.id).map((t) => (
              <Sequence key={t.id} from={t.startFrame} durationInFrames={t.endFrame - t.startFrame} name={t.id} layout="none">
                <Text item={t} brand={brand} safeZone={zone} shotStart={span.start} />
              </Sequence>
            ))}
            {(timeline.voice || []).filter((v) => v.shotId === shot.id).map((v) => (
              <Sequence key={v.id} from={v.startFrame || 0} name={v.id} layout="none">
                <Audio src={staticFile(assets[v.assetId].file)} />
              </Sequence>
            ))}
          </Sequence>
        );
      })}
      {timeline.music && assets[timeline.music.assetId] ? (
        <Audio
          src={staticFile(assets[timeline.music.assetId].file)}
          loop
          loopVolumeCurveBehavior="extend"
          volume={(f) => musicVolume(f, timeline, voiceWindows(timeline, Object.fromEntries(Object.entries(assets).map(([id, a]) => [id, a.durationSec]))))}
        />
      ) : null}
      {timeline.disclosure?.text ? <Pill id="disclosure" zone={zone} brand={brand} len={totalFrames(timeline)} offset={0} lang={timeline.disclosure.lang} bottom={timeline.disclosure.position === 'bottom'}>{timeline.disclosure.text}</Pill> : null}
    </AbsoluteFill>
  );
};

function FadeIn({ frames, children }) {
  const frame = useCurrentFrame();
  const opacity = frames ? interpolate(frame, [0, frames], [0, 1], { extrapolateRight: 'clamp' }) : 1;
  return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>;
}
