#!/usr/bin/env node
// marketing-video CLI. Every subcommand reads and writes one run directory:
//   <root>/.specs/marketing-video/<project>/<run-id>/
// Usage: node mv.mjs <command> --run <run-dir> [options]   (see `help`)
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { SCRIPTS_DIR, compositorDir, depsDir, ensureDeps, inDepsCwd, lockDigest, requireDeps, tool } from './lib/env.mjs';
import { ASSET_KINDS, checkRun } from './lib/gates.mjs';
import { extractPng, frameDiff, fullDecode, levels, pcmSamples, probe, rawFrame, silences } from './lib/media.mjs';
import { LANG_PATTERN, SCHEMA_VERSION, appendDecision, assertId, containedPath, copyDeliverable, deliverablePath, ensureRestricted, runWritePath, projectDir, readDecisions, readJson, runPaths, sha256File, sha256Json, writeJson } from './lib/run.mjs';
import { evidenceFrames, frameTime, layoutFindings, silenceFindings } from './lib/qa.mjs';
import { classifyShots, globalsDigest, shotHashes } from './lib/revision.mjs';
import { shotSpans, totalFrames, voiceFrames } from './lib/timing.mjs';

const RENDER_SETTINGS = { codec: 'h264', crf: 18, pixelFormat: 'yuv420p', audioCodec: 'aac' };
const COMPARE_THRESHOLD = { mean: 1.0, p99: 8 };
// Library files the composition imports; they travel with every snapshot.
const COMPOSITION_LIBS = ['timing.mjs', 'camera.mjs'];

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i += 1; }
    } else out._.push(a);
  }
  return out;
}

function need(opts, ...keys) {
  for (const k of keys) if (opts[k] === undefined || opts[k] === true) throw new Error(`--${k} is required`);
}

function load(runDir) {
  const p = runPaths(runDir);
  return {
    p,
    project: readJson(p.project),
    manifest: readJson(p.manifest, { schemaVersion: SCHEMA_VERSION, assets: [] }),
    claims: readJson(p.claims, { schemaVersion: SCHEMA_VERSION, claims: [] }),
    timeline: readJson(p.timeline, null),
    approvals: readJson(p.approvals, { schemaVersion: SCHEMA_VERSION, approvals: [] }),
  };
}

function fileInfoFor(runDir) {
  return (file) => {
    const d = deliverablePath(runDir, file || '');
    return d.ok ? { deliverable: true, sha256: sha256File(d.real) } : { deliverable: false, reason: d.reason };
  };
}

// Gates evaluated on a revision snapshot: its own timeline, claims, manifest
// and copied assets, with the run's current approvals.
function snapshotGates(runDir, snap) {
  const fileInfo = (file) => {
    const d = deliverablePath(runDir, join(snap, file || ''));
    return d.ok ? { deliverable: true, sha256: sha256File(d.real) } : { deliverable: false, reason: d.reason };
  };
  return checkRun({
    project: readJson(join(snap, 'project.resolved.json')), manifest: readJson(join(snap, 'asset-manifest.json')),
    claims: readJson(join(snap, 'claims.json')), timeline: readJson(join(snap, 'timeline.json')),
    approvals: readJson(runPaths(runDir).approvals, { approvals: [] }), fileInfo,
  });
}

function gate(runDir, timeline) {
  const r = load(runDir);
  return checkRun({ ...r, timeline: timeline || r.timeline || {}, fileInfo: fileInfoFor(runDir) });
}

// ---------------------------------------------------------------- preflight
async function preflight(opts) {
  const report = { node: process.versions.node, nodeOk: Number(process.versions.node.split('.')[0]) >= 20, depsDir: depsDir(), lockDigest: lockDigest() };
  try { report.deps = ensureDeps({ install: Boolean(opts.install) }); } catch (e) { report.deps = { error: e.message }; }
  if (!report.deps.error) {
    report.compositor = compositorDir();
    const v = tool('ffmpeg', ['-hide_banner', '-version']);
    report.ffmpeg = v.status === 0 ? v.stdout.split('\n')[0] : `unavailable: ${v.stderr}`;
    const { ensureBrowser } = requireDeps()('@remotion/renderer');
    if (opts.install) report.browser = await inDepsCwd(() => ensureBrowser());
    else report.browser = existsSync(join(depsDir(), '.remotion')) ? 'present' : 'missing (run with --install; ~95 MB download, no cost)';
  }
  const say = spawnSync('say', ['-v', '?'], { encoding: 'utf8' });
  report.voices = say.status === 0
    ? { provider: 'say (macOS)', arabic: say.stdout.split('\n').filter((l) => /\bar_/.test(l)).map((l) => l.trim()), note: 'local, zero cost, commercial-use rights unverified, no Egyptian Arabic voice' }
    : { provider: 'none', note: 'no local TTS; captions only' };
  report.capture = 'automated browser capture is not built in this version; use manual recordings or screenshots';
  console.log(JSON.stringify(report, null, 2));
}

// --------------------------------------------------------------------- init
function init(opts) {
  need(opts, 'project', 'run');
  assertId(opts.project, '--project');
  assertId(opts.run, '--run');
  const root = resolve(opts.root || '.');
  const pdir = projectDir(root, opts.project);
  const runDir = join(pdir, opts.run);
  if (existsSync(runDir)) throw new Error(`run already exists: ${runDir}`);
  const projectFile = join(pdir, 'project.json');
  if (!existsSync(projectFile)) {
    writeJson(projectFile, {
      schemaVersion: SCHEMA_VERSION, id: opts.project, name: opts.project,
      brand: { colors: { primary: '#4f46e5', ink: '#111318', accent: '#f59e0b' }, fontFamily: null, logoAssetId: null },
      languages: ['en'], audience: '', tone: '', prohibitedClaims: [], channels: ['instagram-reels'],
      exportPresets: { reel: { width: 1080, height: 1920, fps: 30, safeZone: { top: 220, bottom: 380, left: 64, right: 64 } } },
      execution: { allowed: ['local', 'browser', 'free_api', 'paid_api'], optimize: ['quality_threshold', 'incremental_cost', 'simplicity', 'reliability'], allowHumanLogin: true, allowHumanCaptcha: true, approvalRequiredFor: ['paid_api', 'credit_spend', 'purchase', 'publish'], maxAutomaticRetries: 2 },
      providers: { voice: { preferred: 'auto', enabled: [] }, videoGeneration: { preferred: 'auto', enabled: [] }, render: { preferred: 'local' } },
      toolRights: { remotion: { commercialUse: 'unknown', license: 'Remotion License (free for individuals and companies up to 3 people; company license otherwise)', source: 'https://www.remotion.dev/license' } },
      captureOrigins: [],
      disclosureLabels: ['Demo fixture · synthetic data', 'نسخة تجريبية · بيانات وهمية', 'Animated screenshots of the real product', 'لقطات شاشة متحركة من المنتج الفعلي'],
    });
  }
  const p = runPaths(runDir);
  ensureRestricted(runDir);
  for (const d of [p.assets, p.previews, p.exports, p.reports, p.snapshots]) mkdirSync(d, { recursive: true });
  writeJson(p.brief, { schemaVersion: SCHEMA_VERSION, objective: '', contentType: 'reel', cta: '', audience: '', durationSec: 15, format: 'reel', languages: ['en'], budget: { unit: 'USD', cap: 0 }, sourceEvidence: [] });
  writeJson(p.manifest, { schemaVersion: SCHEMA_VERSION, assets: [] });
  writeJson(p.claims, { schemaVersion: SCHEMA_VERSION, claims: [] });
  writeJson(p.approvals, { schemaVersion: SCHEMA_VERSION, approvals: [] });
  appendDecision(runDir, { type: 'init', project: opts.project, run: opts.run });
  console.log(runDir);
}

// ------------------------------------------------------------------- ingest
function mediaInfo(file, kind) {
  const ext = extname(file).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
    const pr = probe(file);
    return { width: pr.video?.width, height: pr.video?.height, hasAudio: false };
  }
  const pr = probe(file);
  return { width: pr.video?.width, height: pr.video?.height, durationSec: pr.durationSec, hasAudio: Boolean(pr.audio), kind };
}

function ingest(opts) {
  need(opts, 'run', 'file', 'id', 'kind', 'method', 'origin');
  const runDir = resolve(opts.run);
  const { p, manifest } = load(runDir);
  if (manifest.assets.some((a) => a.id === opts.id)) throw new Error(`asset ${opts.id} already exists`);
  assertId(opts.id, '--id');
  const methods = ASSET_KINDS[opts.kind];
  if (!methods) throw new Error(`--kind must be one of ${Object.keys(ASSET_KINDS).join(', ')}`);
  // A downloaded voice take (e.g. made by hand on a provider's website) must
  // say which provider made it and exactly which words it speaks.
  if (opts.kind === 'voice' && (!opts.text || !opts.provider)) throw new Error('a voice file needs --provider and --text (the exact words it speaks)');
  if ((opts.from !== undefined || opts.to !== undefined) && opts.kind !== 'voice') throw new Error('--from/--to only cut voice files');
  if (!methods.includes(opts.method)) throw new Error(`--kind ${opts.kind} cannot come from --method ${opts.method}; allowed: ${methods.join(', ')}`);
  if (opts.kind === 'generated' && !opts.provider) throw new Error('a generated asset needs --provider');
  const src = resolve(opts.file);
  const ext = extname(src).toLowerCase();
  if (!/^\.(png|jpe?g|webp|mp4|mov|m4v|webm|wav|mp3|m4a)$/.test(ext)) throw new Error(`unsupported file type ${ext}`);
  ensureRestricted(runDir);
  const original = runWritePath(runDir, p.originals, `${opts.id}${ext}`);
  const derived = runWritePath(runDir, p.assets, `${opts.id}${ext}`);
  let derivedFile = derived;
  copyFileSync(src, original);
  if (opts.kind === 'voice' && (opts.from !== undefined || opts.to !== undefined)) {
    // One take often holds several lines: cut the requested span to WAV.
    const from = Number(opts.from || 0);
    const to = opts.to !== undefined ? Number(opts.to) : null;
    if (!(from >= 0) || (to !== null && !(to > from))) throw new Error('--from/--to must be seconds with to > from');
    const out = runWritePath(runDir, p.assets, `${opts.id}.wav`);
    const r = tool('ffmpeg', ['-v', 'error', '-i', original, '-ss', String(from), ...(to !== null ? ['-to', String(to)] : []), '-ac', '1', '-c:a', 'pcm_s16le', '-y', out]);
    if (r.status !== 0) throw new Error(`cutting the voice file failed: ${r.stderr.trim()}`);
    derivedFile = out;
  } else copyFileSync(src, derived);
  const sha = sha256File(derivedFile);
  const asset = {
    id: opts.id, kind: opts.kind, file: relative(runDir, derivedFile), sha256: sha,
    original: { file: relative(runDir, original), sha256: sha256File(original), sourceName: basename(src), ...(opts.from !== undefined || opts.to !== undefined ? { cut: { from: Number(opts.from || 0), to: opts.to !== undefined ? Number(opts.to) : null } } : {}) },
    captureMethod: opts.method,
    provenance: {
      origin: opts.origin, ingestedAt: new Date().toISOString(),
      ...(opts.url ? { url: opts.url } : {}), ...(opts.environment ? { environment: opts.environment } : {}),
      ...(opts.scenario ? { scenarioSha256: opts.scenario } : {}),
      ...(opts.provider ? { provider: opts.provider } : {}),
      ...(opts.text ? { text: opts.text, textVerifiedBy: opts['text-verified-by'] || 'unverified' } : {}),
      cost: { amount: Number(opts['cost-amount'] || 0), unit: opts['cost-unit'] || 'USD' },
      ...(opts.approval ? { approvalId: opts.approval } : {}),
    },
    rights: { commercialUse: opts.rights || 'unknown', source: opts['rights-source'] || null, license: opts.license || null },
    sensitivity: { status: 'unreviewed' },
    media: mediaInfo(derivedFile, opts.kind),
    audioPolicy: opts.kind === 'voice' ? 'keep' : opts.audio || 'mute',
  };
  manifest.assets.push(asset);
  writeJson(p.manifest, manifest);
  appendDecision(runDir, { type: 'ingest', asset: opts.id, kind: opts.kind, method: opts.method });
  console.log(JSON.stringify(asset, null, 2));
}

// ------------------------------------------------------------------- attest
function attest(opts) {
  need(opts, 'run', 'asset', 'status', 'method');
  const runDir = resolve(opts.run);
  const { p, manifest } = load(runDir);
  const asset = manifest.assets.find((a) => a.id === opts.asset);
  if (!asset) throw new Error(`unknown asset ${opts.asset}`);
  if (!['clean', 'redacted', 'contains-sensitive'].includes(opts.status)) throw new Error('--status must be clean, redacted or contains-sensitive');
  if (opts.status === 'redacted' && !asset.sanitized) throw new Error('redacted requires a sanitize step first');
  asset.sensitivity = {
    status: opts.status, method: opts.method, reviewedBy: opts.by || 'agent', reviewedAt: new Date().toISOString(),
    reviewedSha256: sha256File(join(runDir, asset.file)), framesReviewed: opts.frames ? Number(opts.frames) : null,
    notes: opts.notes || null,
    limitation: 'agent-inspected sampled frames; not machine-verified and not a guarantee that no sensitive data is present',
  };
  writeJson(p.manifest, manifest);
  appendDecision(runDir, { type: 'privacy-attestation', asset: asset.id, status: opts.status, method: opts.method });
  console.log(JSON.stringify(asset.sensitivity, null, 2));
}

// ------------------------------------------------------------------ bundling
// Remotion keeps its webpack cache under <rootDir>/node_modules/.cache, so the
// root is the dependency cache. Left to default it lands beside the entry
// point: inside the skill folder (making a copied install look edited) or
// inside a revision snapshot (bloating every package).
async function bundleWith(publicDir, sourceDir = SCRIPTS_DIR) {
  ensureDeps();
  const { bundle } = requireDeps()('@remotion/bundler');
  return bundle({
    entryPoint: join(sourceDir, 'composition', 'index.jsx'),
    publicDir,
    rootDir: depsDir(),
    webpackOverride: (c) => ({ ...c, resolve: { ...c.resolve, modules: [join(depsDir(), 'node_modules'), 'node_modules'] } }),
  });
}

// ----------------------------------------------------------------- sanitize
async function sanitize(opts) {
  need(opts, 'run', 'asset', 'boxes');
  const runDir = resolve(opts.run);
  const { p, manifest } = load(runDir);
  const asset = manifest.assets.find((a) => a.id === opts.asset);
  if (!asset) throw new Error(`unknown asset ${opts.asset}`);
  if (!['screenshot', 'recording'].includes(asset.kind)) throw new Error('sanitize masks screenshots and recordings only');
  const video = asset.kind === 'recording';
  const boxes = JSON.parse(opts.boxes);
  const stage = mkdtempSync(join(tmpdir(), 'mv-sanitize-'));
  try {
    const name = `in${extname(asset.original.file)}`;
    copyFileSync(join(runDir, asset.original.file), join(stage, name));
    const serveUrl = await bundleWith(stage);
    const { renderMedia, renderStill, selectComposition } = requireDeps()('@remotion/renderer');
    const props = { file: name, width: asset.media.width, height: asset.media.height, boxes, video, durationSec: asset.media.durationSec || 1 };
    const out = runWritePath(runDir, p.assets, `${asset.id}.${video ? 'mp4' : 'png'}`);
    await inDepsCwd(async () => {
      const composition = await selectComposition({ serveUrl, id: video ? 'SanitizeVideo' : 'Sanitize', inputProps: props });
      if (video) await renderMedia({ composition, serveUrl, inputProps: props, outputLocation: out, codec: 'h264', crf: 16, muted: true, overwrite: true });
      else await renderStill({ composition, serveUrl, output: out, inputProps: props, imageFormat: 'png' });
    });
    if (asset.file !== relative(runDir, out)) rmSync(join(runDir, asset.file), { force: true });
    asset.file = relative(runDir, out);
    asset.sha256 = sha256File(out);
    asset.sanitized = { boxes, at: new Date().toISOString(), method: `opaque static masks baked into a derivative ${video ? 'video (30 fps, audio removed)' : 'still'}` };
    if (video) { asset.media = mediaInfo(out, 'recording'); asset.audioPolicy = 'mute'; }
    asset.sensitivity = { status: 'unreviewed', note: 're-inspect the masked derivative, then attest --status redacted' };
    writeJson(p.manifest, manifest);
    appendDecision(runDir, { type: 'sanitize', asset: asset.id, boxes: boxes.length });
    console.log(out);
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

// -------------------------------------------------------------------- voice
function voice(opts) {
  need(opts, 'run', 'id', 'provider', 'text');
  const runDir = resolve(opts.run);
  const { p, manifest } = load(runDir);
  assertId(opts.id, '--id');
  if (opts.provider !== 'say') throw new Error(`voice provider ${opts.provider} is not implemented; use captions only or provider say`);
  if (manifest.assets.some((a) => a.id === opts.id)) throw new Error(`asset ${opts.id} already exists`);
  const out = runWritePath(runDir, p.assets, `${opts.id}.wav`);
  const sayArgs = ['--data-format=LEI16@24000', '-o', out];
  if (opts.voice) sayArgs.unshift('-v', opts.voice);
  if (opts.rate) sayArgs.unshift('-r', String(opts.rate));
  const r = spawnSync('say', [...sayArgs, opts.text], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`say failed: ${r.stderr}`);
  const sha = sha256File(out);
  const asset = {
    id: opts.id, kind: 'voice', file: relative(runDir, out), sha256: sha, captureMethod: 'tts',
    provenance: { provider: 'local:say', origin: `macOS say${opts.voice ? ` voice ${opts.voice}` : ''}${opts.rate ? ` rate ${opts.rate}` : ''}`, text: opts.text, generatedAt: new Date().toISOString(), cost: { amount: 0, unit: 'USD' } },
    rights: { commercialUse: 'unknown', source: 'Apple macOS system voice', license: 'macOS software license; commercial use of synthesized output not verified' },
    sensitivity: { status: 'clean', method: 'generated-from-authored-text', reviewedSha256: sha, reviewedBy: 'agent' },
    media: { durationSec: probe(out).durationSec, hasAudio: true },
    audioPolicy: 'keep',
  };
  manifest.assets.push(asset);
  writeJson(p.manifest, manifest);
  appendDecision(runDir, { type: 'provider', capability: 'voice', chosen: 'local:say', rejected: opts.rejected || null, incrementalCost: { amount: 0, unit: 'USD' }, status: 'draft-quality' });
  console.log(JSON.stringify({ id: asset.id, durationSec: asset.media.durationSec }, null, 2));
}

// -------------------------------------------------------------------- check
function check(opts) {
  need(opts, 'run');
  const result = gate(resolve(opts.run));
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'pass') process.exitCode = 1;
}

// ------------------------------------------------------------------ hashing
function compositionDigest() {
  const files = [...readdirSync(join(SCRIPTS_DIR, 'composition')).map((f) => join(SCRIPTS_DIR, 'composition', f)), ...COMPOSITION_LIBS.map((f) => join(SCRIPTS_DIR, 'lib', f))].sort();
  return sha256Json(files.map((f) => [relative(SCRIPTS_DIR, f), sha256File(f)]));
}

// ------------------------------------------------------------------- render
// Render a self-contained snapshot directory: its own composition copy,
// timeline, resolved project and sanitized assets. Used by `render` and by
// `render-snapshot`, so a delivered editable project reproduces itself.
async function renderSnapshot(snap, out) {
  const timeline = readJson(join(snap, 'timeline.json'));
  const project = readJson(join(snap, 'project.resolved.json'));
  const manifest = readJson(join(snap, 'asset-manifest.json'));
  const preset = project.exportPresets?.[timeline.preset || 'reel'] || {};
  const assets = Object.fromEntries(manifest.assets.map((a) => [a.id, {
    file: basename(a.file), kind: a.kind, width: a.media?.width, height: a.media?.height, audioPolicy: a.audioPolicy,
  }]));
  const props = { timeline, assets, brand: project.brand || {}, safeZone: preset.safeZone || {} };
  const layout = [];
  const serveUrl = await bundleWith(join(snap, 'assets'), snap);
  const { renderMedia, selectComposition } = requireDeps()('@remotion/renderer');
  await inDepsCwd(async () => {
    const composition = await selectComposition({ serveUrl, id: 'MarketingVideo', inputProps: props });
    await renderMedia({
      composition, serveUrl, inputProps: props, outputLocation: out, codec: RENDER_SETTINGS.codec, crf: RENDER_SETTINGS.crf,
      pixelFormat: RENDER_SETTINGS.pixelFormat, audioCodec: RENDER_SETTINGS.audioCodec, overwrite: true,
      onBrowserLog: (l) => { if (l.text.startsWith('MV_LAYOUT ')) layout.push(JSON.parse(l.text.slice(10))); },
    });
  });
  return layout;
}

async function render(opts) {
  need(opts, 'run');
  const runDir = resolve(opts.run);
  const { p, project, manifest, claims, timeline } = load(runDir);
  if (!timeline) throw new Error('timeline.json is missing');
  const rev = timeline.revision;
  if (!Number.isInteger(rev) || rev < 1) throw new Error('timeline.revision must be a positive integer');
  const gates = gate(runDir);
  if (gates.status !== 'pass') {
    console.log(JSON.stringify(gates, null, 2));
    throw new Error('gates blocked the render; fix the findings above');
  }
  const snap = join(p.snapshots, `r${rev}`);
  const out = join(p.previews, `r${rev}.mp4`);
  const globals = globalsDigest({ compositionDigest: compositionDigest(), lockDigest: lockDigest(), renderSettings: RENDER_SETTINGS, project, timeline });
  const hashes = shotHashes(timeline, manifest);
  if (existsSync(out) || existsSync(snap)) {
    // A revision number names one set of inputs forever. Re-rendering is only
    // allowed for identical inputs, so reviews and approvals of r<N> can never
    // be carried over to different content.
    const prior = readJson(join(snap, 'render.json'), {});
    const same = prior.timelineSha256 === sha256Json(timeline) && prior.globalsDigest === globals && sha256Json(prior.shotHashes || {}) === sha256Json(hashes);
    if (!opts.force) throw new Error(`r${rev} already rendered; set "parentRevision": ${rev} and bump timeline.revision for any change`);
    if (!same) throw new Error(`r${rev}'s inputs changed since it was rendered; --force only re-renders identical inputs. Bump timeline.revision.`);
  }
  // Assets shown, spoken, or cited as claim evidence all travel with the snapshot.
  const evidence = (claims.claims || []).flatMap((c) => (c.evidence || []).filter((e) => e.type === 'asset').map((e) => e.ref));
  const used = new Set([...timeline.shots.map((s) => s.assetId), ...(timeline.voice || []).map((v) => v.assetId), ...evidence].filter((id) => id && manifest.assets.some((a) => a.id === id)));
  const usedAssets = manifest.assets.filter((a) => used.has(a.id));
  const started = Date.now();
  // Snapshot first, then render from it: what was rendered is exactly what
  // was saved.
  rmSync(snap, { recursive: true, force: true });
  mkdirSync(join(snap, 'lib'), { recursive: true });
  mkdirSync(join(snap, 'assets'), { recursive: true });
  cpSync(join(SCRIPTS_DIR, 'composition'), join(snap, 'composition'), { recursive: true });
  for (const f of COMPOSITION_LIBS) copyFileSync(join(SCRIPTS_DIR, 'lib', f), join(snap, 'lib', f));
  copyFileSync(join(SCRIPTS_DIR, 'package.json'), join(snap, 'package.json'));
  copyFileSync(join(SCRIPTS_DIR, 'package-lock.json'), join(snap, 'package-lock.json'));
  for (const a of usedAssets) {
    const d = deliverablePath(runDir, a.file);
    if (!d.ok) throw new Error(`asset ${a.id}: ${d.reason}`);
    if (sha256File(d.real) !== a.sha256) throw new Error(`asset ${a.id} changed after the gates ran`);
    copyFileSync(d.real, join(snap, 'assets', basename(a.file)));
  }
  writeJson(join(snap, 'timeline.json'), timeline);
  writeJson(join(snap, 'project.resolved.json'), project);
  writeJson(join(snap, 'claims.json'), claims);
  writeJson(join(snap, 'asset-manifest.json'), { ...manifest, assets: usedAssets.map((a) => ({ ...a, file: join('assets', basename(a.file)) })) });
  const layout = await renderSnapshot(snap, out);
  writeJson(join(snap, 'render.json'), {
    schemaVersion: SCHEMA_VERSION, revision: rev, parentRevision: timeline.parentRevision ?? null, settings: RENDER_SETTINGS,
    globalsDigest: globals, shotHashes: hashes, timelineSha256: sha256Json(timeline), snapshotSha256: snapshotDigest(snap),
    output: relative(runDir, out), outputSha256: sha256File(out),
    fonts: 'system fonts of the rendering machine (reproducibility limitation) plus brand.fontFamily if installed',
    command: 'node <skill-dir>/scripts/mv.mjs render-snapshot --snapshot <this folder> --out <file.mp4>', renderMs: Date.now() - started,
  });
  writeJson(join(p.reports, `r${rev}`, 'layout.json'), layout);
  appendDecision(runDir, { type: 'render', revision: rev, path: 'local:remotion', incrementalCost: { amount: 0, unit: 'USD' }, ms: Date.now() - started });
  console.log(JSON.stringify({ output: out, revision: rev, layoutMeasurements: layout.length, ms: Date.now() - started }, null, 2));
}

async function renderSnapshotCmd(opts) {
  need(opts, 'snapshot', 'out');
  const snap = resolve(opts.snapshot);
  if (!existsSync(join(snap, 'render.json'))) throw new Error(`${snap} is not a revision snapshot`);
  const out = resolve(opts.out);
  if (existsSync(out)) throw new Error(`${out} exists; choose a new file`);
  const layout = await renderSnapshot(snap, out);
  console.log(JSON.stringify({ output: out, layoutMeasurements: layout.length, note: 'render settings match; output bytes can differ across machines (fonts, encoder build)' }, null, 2));
}

// ------------------------------------------------------------------- verify
function verify(opts) {
  need(opts, 'run', 'rev');
  const runDir = resolve(opts.run);
  const rev = Number(opts.rev);
  const { p } = load(runDir);
  const snap = join(p.snapshots, `r${rev}`);
  const timeline = readJson(join(snap, 'timeline.json'));
  const renderMeta = readJson(join(snap, 'render.json'));
  const project = readJson(join(snap, 'project.resolved.json'));
  const mp4 = join(runDir, renderMeta.output);
  const reportDir = join(p.reports, `r${rev}`);
  const frameDir = join(reportDir, 'frames');
  rmSync(frameDir, { recursive: true, force: true });
  mkdirSync(frameDir, { recursive: true });
  const checks = [];
  const ok = (id, pass, detail) => checks.push({ id, status: pass ? 'pass' : 'fail', detail });

  const mp4Sha = sha256File(mp4);
  ok('QA-BINDING', mp4Sha === renderMeta.outputSha256, `mp4 sha256 ${mp4Sha.slice(0, 12)} vs rendered ${renderMeta.outputSha256.slice(0, 12)}`);
  const pr = probe(mp4);
  const expectFrames = totalFrames(timeline);
  ok('QA-CODEC', pr.video?.codec_name === 'h264', `video codec ${pr.video?.codec_name}`);
  ok('QA-DIMENSIONS', pr.video?.width === timeline.width && pr.video?.height === timeline.height, `${pr.video?.width}x${pr.video?.height}, expected ${timeline.width}x${timeline.height}`);
  ok('QA-FPS', pr.video?.r_frame_rate === `${timeline.fps}/1`, `fps ${pr.video?.r_frame_rate}`);
  ok('QA-FRAMES', Math.abs(Number(pr.video?.nb_frames) - expectFrames) <= 1, `${pr.video?.nb_frames} frames, expected ${expectFrames}`);
  ok('QA-DURATION', Math.abs(pr.durationSec - expectFrames / timeline.fps) <= 2 / timeline.fps + 0.05, `${pr.durationSec.toFixed(3)}s, expected ${(expectFrames / timeline.fps).toFixed(3)}s`);
  const dec = fullDecode(mp4);
  ok('QA-DECODE', dec.ok, dec.ok ? 'every frame and sample decoded without error' : dec.stderr.slice(0, 400));

  // Audio policy: voice segments and kept recording audio are the only sources.
  const manifest = readJson(join(snap, 'asset-manifest.json'));
  const assets = new Map(manifest.assets.map((a) => [a.id, a]));
  const keptRecordingAudio = timeline.shots.some((s) => assets.get(s.assetId)?.audioPolicy === 'keep' && assets.get(s.assetId)?.media?.hasAudio);
  const expectAudio = (timeline.voice || []).length > 0 || keptRecordingAudio;
  const audio = { expected: expectAudio, present: Boolean(pr.audio), segments: [] };
  if (expectAudio) {
    ok('QA-AUDIO-STREAM', Boolean(pr.audio), pr.audio ? `audio ${pr.audio.codec_name}` : 'voice declared but no audio stream');
    if (pr.audio) {
      const { rate, samples } = pcmSamples(mp4);
      const all = levels(samples);
      audio.overall = all;
      ok('QA-AUDIO-CLIP', all.clippedRatio < 0.001 && all.peakDb <= -0.1, `peak ${all.peakDb.toFixed(1)} dBFS, clipped ${(all.clippedRatio * 100).toFixed(3)}%`);
      const starts = new Map(shotSpans(timeline).map((s) => [s.id, s.start]));
      for (const v of timeline.voice || []) {
        const from = ((starts.get(v.shotId) + (v.startFrame || 0)) / timeline.fps) * rate;
        const len = (voiceFrames(assets.get(v.assetId), timeline.fps) / timeline.fps) * rate;
        const l = levels(samples, Math.floor(from), Math.floor(from + len));
        audio.segments.push({ id: v.id, ...l });
        ok(`QA-VOICE:${v.id}`, l.rmsDb > -40, `voice window RMS ${l.rmsDb.toFixed(1)} dBFS (silent below -40)`);
      }
      const gaps = silenceFindings(silences(mp4), pr.durationSec);
      audio.silentGaps = gaps;
      ok('QA-SILENCE-GAP', !gaps.length, gaps.length
        ? `silent for ${gaps.map((g) => `${g.start.toFixed(1)}–${g.end.toFixed(1)}s`).join(', ')} in a voiced video (max 2.0 s mid-video, 3.0 s at the end)`
        : 'no silent stretch over 2.0 s mid-video or 3.0 s at the end');
    }
  } else {
    ok('QA-AUDIO-STREAM', !pr.audio || levels(pcmSamples(mp4).samples).rmsDb < -60, pr.audio ? 'no audio declared; stream present and checked silent' : 'no audio declared, none present');
  }

  // Measured caption geometry: every text item must have reported its box.
  const layout = readJson(join(reportDir, 'layout.json'), []);
  const kinds = Object.fromEntries(manifest.assets.map((a) => [a.id, a.kind]));
  for (const f of layoutFindings(timeline, layout, project.exportPresets?.[timeline.preset || 'reel']?.safeZone, kinds)) ok(`QA-LAYOUT:${f.id}`, f.pass, f.detail);

  // Evidence frames, independently decoded from the final MP4.
  const frames = evidenceFrames(timeline).map((f) => {
    const file = join(frameDir, `f${String(f.frame).padStart(5, '0')}.png`);
    extractPng(mp4, frameTime(f.frame, timeline.fps), file);
    return { ...f, t: +(f.frame / timeline.fps).toFixed(3), file: relative(runDir, file), sha256: sha256File(file) };
  });
  ok('QA-EVIDENCE', frames.length > 0 && frames.every((f) => existsSync(join(runDir, f.file))), `${frames.length} frames extracted`);

  const gates = snapshotGates(runDir, snap);
  ok('QA-GATES', gates.status === 'pass', `${gates.findings.length} gate findings; delivery ${gates.deliveryStatus}`);

  const failed = checks.filter((c) => c.status === 'fail');
  const report = {
    schemaVersion: SCHEMA_VERSION, revision: rev, status: failed.length ? 'fail' : 'pass',
    binding: { mp4Sha256: mp4Sha, timelineSha256: sha256Json(timeline), snapshotSha256: snapshotDigest(snap), extraction: { method: 'ffmpeg -ss frame/fps - 0.5ms, 1 frame, PNG', frames: frames.length } },
    deliveryStatus: failed.length ? 'blocked' : gates.deliveryStatus,
    checks, audio, gates, frames,
    requiresHuman: [
      'hook strength, pacing and story clarity (judged from playback)',
      'audio/voice sync, voice quality and dialect (no agent has a listening route)',
      'motion smoothness and transitions between sampled frames',
      'perceived caption legibility on a phone',
      'semantic truth of every factual line and of text visible inside footage',
      'privacy beyond the sampled frames',
    ],
  };
  writeJson(join(reportDir, 'qa.json'), report);
  writeFileSync(join(reportDir, 'qa.md'), qaMarkdown(report));
  console.log(JSON.stringify({ status: report.status, deliveryStatus: report.deliveryStatus, failed: failed.map((c) => `${c.id}: ${c.detail}`), frames: frames.length, report: join(reportDir, 'qa.md') }, null, 2));
  if (failed.length) process.exitCode = 1;
}

function qaMarkdown(r) {
  const rows = r.checks.map((c) => `| ${c.status === 'pass' ? 'PASS' : '**FAIL**'} | ${c.id} | ${c.detail.replaceAll('|', '\\|')} |`).join('\n');
  const gates = r.gates.findings.map((f) => `- [${f.severity}] ${f.gate}: ${f.message}`).join('\n') || '- none';
  return `# QA — revision ${r.revision}\n\nStatus: **${r.status}** · delivery: **${r.deliveryStatus}**\n\nBound to MP4 \`${r.binding.mp4Sha256}\` and timeline \`${r.binding.timelineSha256}\`.\n\n| Result | Check | Detail |\n|---|---|---|\n${rows}\n\n## Gate findings\n\n${gates}\n\n## Not verified by automation (requires human judgment)\n\n${r.requiresHuman.map((h) => `- ${h}`).join('\n')}\n\n## Evidence frames\n\n${r.frames.map((f) => `- frame ${f.frame} (${f.t}s, ${f.why}, ${f.shotId}): \`${f.file}\``).join('\n')}\n`;
}

// ------------------------------------------------------------------ compare
function compare(opts) {
  need(opts, 'run', 'from', 'to');
  const runDir = resolve(opts.run);
  const { p } = load(runDir);
  const side = (rev) => {
    const snap = join(p.snapshots, `r${rev}`);
    const meta = readJson(join(snap, 'render.json'));
    return { rev, meta, timeline: readJson(join(snap, 'timeline.json')), mp4: join(runDir, meta.output) };
  };
  const a = side(Number(opts.from));
  const b = side(Number(opts.to));
  const { globalsChanged, shots: classified } = classifyShots(a.meta, b.meta);
  const spansA = new Map(shotSpans(a.timeline).map((s) => [s.id, s]));
  const spansB = new Map(shotSpans(b.timeline).map((s) => [s.id, s]));
  const shots = classified.map(({ id, inBoth, affected, reason }) => {
    const same = !affected;
    const entry = { id, affected, reason };
    if (!inBoth) return entry;
    const sa = spansA.get(id);
    const sb = spansB.get(id);
    const len = Math.min(sa.end - sa.start, sb.end - sb.start);
    const offsets = [...new Set([0, Math.floor(len * 0.25), Math.floor(len * 0.5), Math.floor(len * 0.75), len - 1])];
    entry.samples = offsets.map((o) => {
      const d = frameDiff(rawFrame(a.mp4, frameTime(sa.start + o, a.timeline.fps)), rawFrame(b.mp4, frameTime(sb.start + o, b.timeline.fps)));
      return { offset: o, mean: +d.mean.toFixed(3), p99: d.p99, within: d.comparable && d.mean <= COMPARE_THRESHOLD.mean && d.p99 <= COMPARE_THRESHOLD.p99 };
    });
    if (same) entry.status = entry.samples.every((s) => s.within) ? 'preserved' : 'REGRESSED';
    else entry.status = entry.samples.some((s) => !s.within) ? 'changed' : 'changed-inputs-but-visually-equal';
    return entry;
  });
  const regressed = shots.filter((s) => s.status === 'REGRESSED');
  const report = {
    schemaVersion: SCHEMA_VERSION, from: a.rev, to: b.rev, globalsChanged, threshold: COMPARE_THRESHOLD,
    method: 'shot-local sampled frames (5 per shot) decoded from both MP4s; sampled regression evidence, not pixel proof of whole shots; audio not compared',
    status: regressed.length ? 'fail' : 'pass', shots,
    durations: { fromFrames: totalFrames(a.timeline), toFrames: totalFrames(b.timeline) },
  };
  const out = join(p.reports, `compare-r${a.rev}-r${b.rev}.json`);
  writeJson(out, report);
  console.log(JSON.stringify({ status: report.status, globalsChanged, shots: shots.map((s) => `${s.id}: ${s.status || s.reason}`), report: out }, null, 2));
  if (regressed.length) process.exitCode = 1;
}

// ------------------------------------------------------------------ package
function srtTime(sec, sep) {
  const ms = Math.round(sec * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${sep}${pad(ms % 1000, 3)}`;
}

// Every file of a revision snapshot except render.json (which records the
// digest), so any later edit to captions, config or assets is detectable.
function snapshotFiles(snap) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = join(dir, e.name);
      if (e.isDirectory()) walk(f); else out.push(relative(snap, f));
    }
  };
  walk(snap);
  return out.filter((f) => f !== 'render.json').sort();
}

function snapshotDigest(snap) {
  return sha256Json(snapshotFiles(snap).map((f) => [f, sha256File(join(snap, f))]));
}

// A snapshot holds exactly what render wrote: nothing unlisted gets packaged.
function assertSnapshotFiles(snap) {
  const manifest = readJson(join(snap, 'asset-manifest.json'));
  const allowed = new Set(['timeline.json', 'project.resolved.json', 'claims.json', 'asset-manifest.json', 'package.json', 'package-lock.json',
    ...COMPOSITION_LIBS.map((f) => join('lib', f)), ...manifest.assets.map((a) => a.file)]);
  const extra = snapshotFiles(snap).filter((f) => !allowed.has(f) && !f.startsWith(`composition${sep}`));
  if (extra.length) throw new Error(`snapshot holds unlisted files: ${extra.join(', ')}`);
}

// Reviews and approvals are bound to the exact MP4 bytes and snapshot QA verified.
function currentQa(runDir, rev) {
  const p = runPaths(runDir);
  const qa = readJson(join(p.reports, `r${rev}`, 'qa.json'));
  const snap = join(p.snapshots, `r${rev}`);
  const meta = readJson(join(snap, 'render.json'));
  if (sha256File(join(runDir, meta.output)) !== qa.binding.mp4Sha256) throw new Error(`r${rev}'s MP4 changed after QA; re-run verify`);
  const digest = snapshotDigest(snap);
  if (!qa.binding.snapshotSha256 || digest !== qa.binding.snapshotSha256 || digest !== meta.snapshotSha256) throw new Error(`r${rev}'s snapshot changed after render or QA; bump the revision and render again`);
  return qa;
}

function recordReview(opts) {
  need(opts, 'run', 'rev', 'reviewer', 'verdict', 'file');
  const runDir = resolve(opts.run);
  const rev = Number(opts.rev);
  if (!['claude', 'codex'].includes(opts.reviewer)) throw new Error('--reviewer must be claude or codex');
  if (!['PASS', 'CHANGES_REQUESTED'].includes(opts.verdict)) throw new Error('--verdict must be PASS or CHANGES_REQUESTED');
  const qa = currentQa(runDir, rev);
  const text = readFileSync(resolve(opts.file), 'utf8');
  if (!text.trim()) throw new Error('the review text is empty');
  const record = { schemaVersion: SCHEMA_VERSION, reviewer: opts.reviewer, revision: rev, verdict: opts.verdict, mp4Sha256: qa.binding.mp4Sha256, timelineSha256: qa.binding.timelineSha256, snapshotSha256: qa.binding.snapshotSha256, recordedAt: new Date().toISOString(), text };
  writeJson(join(runPaths(runDir).reports, `r${rev}`, `review-${opts.reviewer}.json`), record);
  appendDecision(runDir, { type: 'review', reviewer: opts.reviewer, revision: rev, verdict: opts.verdict });
  console.log(JSON.stringify({ reviewer: record.reviewer, verdict: record.verdict, mp4Sha256: record.mp4Sha256 }, null, 2));
}

function recordApproval(opts) {
  need(opts, 'run', 'type', 'quote');
  const runDir = resolve(opts.run);
  const p = runPaths(runDir);
  const approvals = readJson(p.approvals, { schemaVersion: SCHEMA_VERSION, approvals: [] });
  const id = assertId(opts.id || `ap-${approvals.approvals.length + 1}`, '--id');
  if (approvals.approvals.some((a) => a.id === id)) throw new Error(`approval ${id} exists`);
  let entry;
  if (opts.type === 'final-video') {
    need(opts, 'rev');
    const qa = currentQa(runDir, Number(opts.rev));
    entry = { id, type: 'final-video', decidedBy: 'user', quote: opts.quote, revision: Number(opts.rev), mp4Sha256: qa.binding.mp4Sha256, snapshotSha256: qa.binding.snapshotSha256 };
  } else if (opts.type === 'spend') {
    need(opts, 'provider', 'unit', 'cap', 'scope');
    entry = { id, type: 'spend', decidedBy: 'user', quote: opts.quote, provider: opts.provider, scope: opts.scope, unit: opts.unit, cap: Number(opts.cap), reserved: 0, consumed: 0, retriesMax: Number(opts.retries || 2), status: 'active', ...(opts.expires ? { expires: opts.expires } : {}) };
  } else throw new Error('--type must be final-video or spend');
  approvals.approvals.push({ ...entry, recordedAt: new Date().toISOString() });
  writeJson(p.approvals, approvals);
  appendDecision(runDir, { type: 'approval', approval: id, kind: entry.type });
  console.log(JSON.stringify(entry, null, 2));
}

function pkg(opts) {
  need(opts, 'run', 'rev');
  const runDir = resolve(opts.run);
  const rev = Number(opts.rev);
  const { p } = load(runDir);
  const snap = join(p.snapshots, `r${rev}`);
  const reportDir = join(p.reports, `r${rev}`);
  const qa = currentQa(runDir, rev);
  if (qa.status !== 'pass') throw new Error(`QA for r${rev} did not pass; nothing is packaged`);
  assertSnapshotFiles(snap);
  const gates = snapshotGates(runDir, snap);
  if (gates.status !== 'pass') throw new Error(`r${rev}'s snapshot no longer passes the gates: ${gates.findings.filter((f) => f.severity === 'block').map((f) => f.message).join('; ')}`);
  const timeline = readJson(join(snap, 'timeline.json'));
  const meta = readJson(join(snap, 'render.json'));
  const bound = (r) => r && r.mp4Sha256 === qa.binding.mp4Sha256 && r.snapshotSha256 === qa.binding.snapshotSha256 && r.revision === rev;
  const reviews = Object.fromEntries(['claude', 'codex'].map((who) => [who, readJson(join(reportDir, `review-${who}.json`), null)]));
  const approval = readJson(p.approvals, { approvals: [] }).approvals.find((a) => a.type === 'final-video' && a.decidedBy === 'user' && bound(a));
  const missing = [];
  if (gates.deliveryStatus !== 'final-eligible') missing.push(`delivery status is ${gates.deliveryStatus}: ${gates.findings.map((f) => f.message).join('; ')}`);
  for (const [who, r] of Object.entries(reviews)) {
    if (!r || r.reviewer !== who || !bound(r)) missing.push(`a ${who} review of exactly this MP4`);
    else if (r.verdict !== 'PASS') missing.push(`${who} review verdict is ${r.verdict}`);
  }
  if (!approval) missing.push('user approval of exactly this MP4 after playback');
  const status = missing.length ? 'draft' : 'final';
  const out = runWritePath(runDir, p.exports, `r${rev}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const files = [];
  const put = (src, name) => files.push(...copyDeliverable(runDir, src, out, name));
  const write = (name, text) => { writeFileSync(containedPath(out, name), text); files.push(name); };
  put(meta.output, `video${status === 'draft' ? '-DRAFT' : ''}.mp4`);
  const starts = new Map(shotSpans(timeline).map((s) => [s.id, s.start]));
  const captions = (timeline.text || []).filter((t) => t.kind === 'caption');
  for (const lang of [...new Set(captions.map((c) => c.lang || 'und'))]) {
    if (!LANG_PATTERN.test(lang)) throw new Error(`invalid caption language tag ${JSON.stringify(lang)}`);
    const cues = captions.filter((c) => (c.lang || 'und') === lang).map((c) => ({ s: (starts.get(c.shotId) + c.startFrame) / timeline.fps, e: (starts.get(c.shotId) + c.endFrame) / timeline.fps, text: c.text })).sort((x, y) => x.s - y.s);
    write(`captions-${lang}.srt`, cues.map((c, i) => `${i + 1}\n${srtTime(c.s, ',')} --> ${srtTime(c.e, ',')}\n${c.text}\n`).join('\n'));
    write(`captions-${lang}.vtt`, `WEBVTT\n\n${cues.map((c) => `${srtTime(c.s, '.')} --> ${srtTime(c.e, '.')}\n${c.text}\n`).join('\n')}`);
  }
  const script = [`# Script — revision ${rev}`, '', '| Shot | Type | Class | Claim | Text |', '|---|---|---|---|---|',
    ...(timeline.voice || []).map((v) => `| ${v.shotId} | voice | ${v.class} | ${v.claimId || ''} | ${v.text} |`),
    ...(timeline.text || []).map((t) => `| ${t.shotId} | ${t.kind} (${t.lang || ''}) | ${t.class} | ${t.claimId || ''} | ${t.text.replaceAll('\n', ' ')} |`)].join('\n');
  write('script.md', `${script}\n`);
  const decisions = readDecisions(runDir);
  const manifest = readJson(join(snap, 'asset-manifest.json'));
  write('cost-report.json', `${JSON.stringify({
    incremental: manifest.assets.map((a) => ({ asset: a.id, ...(a.provenance?.cost || { amount: 0, unit: 'USD' }), approvalId: a.provenance?.approvalId || null })),
    providerDecisions: decisions.filter((d) => ['provider', 'render'].includes(d.type)),
    totals: manifest.assets.reduce((acc, a) => { const c = a.provenance?.cost; if (c?.amount) acc[c.unit] = (acc[c.unit] || 0) + c.amount; return acc; }, {}),
  }, null, 2)}\n`);
  put('decisions.jsonl', 'decisions.jsonl');
  put(relative(runDir, reportDir), 'qa');
  // The snapshot is self-contained (composition, config, claims, sanitized
  // assets), and its assets were re-checked by the gates above.
  put(relative(runDir, snap), 'editable-project');
  const delivery = { schemaVersion: SCHEMA_VERSION, revision: rev, status, missingForFinal: missing, mp4Sha256: qa.binding.mp4Sha256, files: files.sort(), packagedAt: new Date().toISOString() };
  writeJson(join(out, 'delivery.json'), delivery);
  appendDecision(runDir, { type: 'package', revision: rev, status, missing });
  console.log(JSON.stringify(delivery, null, 2));
}

const HELP = `marketing-video CLI
  preflight [--install]                 capabilities; --install fetches pinned deps + headless browser into the user cache
  init --project <id> --run <id> [--root <dir>]
  ingest --run <dir> --file <path> --id <id> --kind screenshot|recording|logo|generated|voice --method manual|automated|screenshot|provided|generated --origin <text> [--url --environment --scenario <sha256> --provider <p> --text <spoken words, voice only> --text-verified-by user (after the user listened) --from <s> --to <s> (cut a voice take) --rights yes|no|unknown --rights-source --license --audio keep|mute --cost-amount --cost-unit --approval <id>]
  attest --run <dir> --asset <id> --status clean|redacted|contains-sensitive --method <how> [--frames <n> --notes]
  sanitize --run <dir> --asset <id> --boxes '[{"x":0,"y":0,"w":10,"h":10}]'
  voice --run <dir> --id <id> --provider say --text <line> [--voice <name> --rate <wpm>]
  check --run <dir>
  render --run <dir> [--force]          --force re-renders identical inputs only
  render-snapshot --snapshot <project/rN dir> --out <file.mp4>
  verify --run <dir> --rev <n>
  compare --run <dir> --from <n> --to <n>
  record-review --run <dir> --rev <n> --reviewer claude|codex --verdict PASS|CHANGES_REQUESTED --file <review.md>
  record-approval --run <dir> --type final-video --rev <n> --quote <user's words>
  record-approval --run <dir> --type spend --provider <p> --scope <s> --unit USD|credits --cap <n> --quote <user's words> [--expires <iso>]
  package --run <dir> --rev <n>`;

const COMMANDS = { preflight, init, ingest, attest, sanitize, voice, check, render, 'render-snapshot': renderSnapshotCmd, verify, compare, 'record-review': recordReview, 'record-approval': recordApproval, package: pkg };

const opts = args(process.argv.slice(2));
const cmd = COMMANDS[opts._[0]];
if (!cmd) { console.log(HELP); process.exit(opts._[0] && opts._[0] !== 'help' ? 2 : 0); }
try { await cmd(opts); } catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
