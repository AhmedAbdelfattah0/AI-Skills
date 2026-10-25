// Measurements on rendered media through the compositor's ffmpeg. The bundled
// build has no volumedetect/select/tile filters, so audio levels and frame
// differences are computed here from raw samples and raw RGB frames.
import { ffprobeJson, tool } from './env.mjs';

export function probe(file) {
  const info = ffprobeJson(file);
  const video = info.streams.find((s) => s.codec_type === 'video');
  const audio = info.streams.find((s) => s.codec_type === 'audio');
  return { info, video, audio, durationSec: Number(info.format?.duration || 0) };
}

export function fullDecode(file) {
  const r = tool('ffmpeg', ['-v', 'error', '-i', file, '-c:v', 'rawvideo', '-c:a', 'pcm_s16le', '-f', 'null', '-']);
  return { ok: r.status === 0 && !r.stderr.trim(), stderr: r.stderr.trim() };
}

export function extractPng(file, timeSec, out) {
  const r = tool('ffmpeg', ['-v', 'error', '-ss', timeSec.toFixed(4), '-i', file, '-frames:v', '1', '-y', out]);
  if (r.status !== 0) throw new Error(`frame extraction at ${timeSec}s failed: ${r.stderr.trim()}`);
  return out;
}

export function rawFrame(file, timeSec) {
  const r = tool('ffmpeg', ['-v', 'error', '-ss', timeSec.toFixed(4), '-i', file, '-frames:v', '1',
    '-f', 'image2pipe', '-c:v', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: null });
  if (r.status !== 0 || !r.stdout?.length) throw new Error(`raw frame at ${timeSec}s failed: ${r.stderr}`);
  return r.stdout;
}

// Mean absolute difference and 99th-percentile channel difference, 0..255.
export function frameDiff(a, b) {
  if (a.length !== b.length) return { mean: 255, p99: 255, comparable: false };
  const hist = new Uint32Array(256);
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = Math.abs(a[i] - b[i]);
    sum += d;
    hist[d] += 1;
  }
  const target = a.length * 0.99;
  let acc = 0;
  let p99 = 0;
  for (; p99 < 256; p99 += 1) { acc += hist[p99]; if (acc >= target) break; }
  return { mean: sum / a.length, p99, comparable: true };
}

// Mono 16-bit PCM at 24 kHz, read from a WAV piped out of ffmpeg.
export function pcmSamples(file) {
  const r = tool('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', '-f', 'wav', '-'], { encoding: null });
  if (r.status !== 0) throw new Error(`audio decode failed: ${r.stderr}`);
  const buf = r.stdout;
  const at = buf.indexOf(Buffer.from('data'));
  if (at < 0) throw new Error('no WAV data chunk');
  const body = buf.subarray(at + 8);
  return { rate: 24000, samples: new Int16Array(body.buffer, body.byteOffset, Math.floor(body.length / 2)) };
}

// Silent stretches of the final audio, from the compositor's silencedetect.
export function silences(file, minSec = 1.5, thresholdDb = -40) {
  const r = tool('ffmpeg', ['-nostats', '-hide_banner', '-vn', '-i', file, '-af', `silencedetect=n=${thresholdDb}dB:d=${minSec}`, '-c:a', 'pcm_s16le', '-f', 'null', '-']);
  // A failed measurement must never read as "no silence".
  if (r.status !== 0) throw new Error(`silence detection failed for ${file}: ${r.stderr.trim().split('\n').pop()}`);
  const out = [];
  let start = null;
  for (const line of r.stderr.split('\n')) {
    const s = line.match(/silence_start: (-?[\d.]+)/);
    const e = line.match(/silence_end: ([\d.]+)/);
    if (s) start = Math.max(0, Number(s[1]));
    if (e && start !== null) { out.push({ start, end: Number(e[1]) }); start = null; }
  }
  if (start !== null) out.push({ start, end: null });
  return out;
}

export function levels(samples, from = 0, to = samples.length) {
  let peak = 0;
  let sq = 0;
  let clipped = 0;
  const n = Math.max(0, Math.min(to, samples.length) - from);
  for (let i = from; i < from + n; i += 1) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
    if (v >= 32767) clipped += 1;
    sq += samples[i] * samples[i];
  }
  const db = (x) => (x > 0 ? 20 * Math.log10(x / 32768) : -Infinity);
  return { peakDb: db(peak), rmsDb: db(Math.sqrt(sq / Math.max(1, n))), clippedRatio: clipped / Math.max(1, n), samples: n };
}
