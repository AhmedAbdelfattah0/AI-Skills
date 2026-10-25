// The run gates. Pure: callers load the JSON and pass a file inspector, so
// every gate is unit-testable without a renderer. A `block` finding stops
// render and delivery; a `draft` finding allows a preview but forbids a final.
import { camAt, cameraBox, contentArea, onScreen } from './camera.mjs';
import { shotSpans, voiceFrames } from './timing.mjs';

const TEXT_CLASSES = new Set(['factual', 'conceptual', 'cta', 'brand', 'neutral']);
// Pixels of the product or the brand: never under a conceptual line.
const REAL_PIXELS = new Set(['recording', 'screenshot', 'logo']);
const SENSITIVITY_OK = new Set(['clean', 'redacted']);
const MIN_CAPTION_SEC = 0.8;
export const ASSET_KINDS = {
  screenshot: ['manual', 'screenshot', 'automated'],
  recording: ['manual', 'automated'],
  logo: ['provided', 'manual'],
  generated: ['generated'],
  voice: ['tts', 'provided'],
};
// Shot fields that would draw an interaction the product never performed.
const SYNTHETIC_INTERACTION = ['interaction', 'cursor', 'click', 'typing', 'tap'];
const SHA = /^[0-9a-f]{64}$/;
const DEFAULT_ZONE = { top: 220, bottom: 380, left: 64, right: 64 };

const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim();

export function checkRun({ project = {}, manifest = {}, claims = {}, timeline = {}, approvals = {}, fileInfo, now = new Date() }) {
  const findings = [];
  const add = (gate, severity, message) => findings.push({ gate, severity, message });

  const assets = new Map((manifest.assets || []).map((a) => [a.id, a]));
  const claimById = new Map((claims.claims || []).map((c) => [c.id, c]));
  const approvalList = approvals.approvals || [];
  const approvalById = new Map(approvalList.map((a) => [a.id, a]));
  const shots = timeline.shots || [];
  const shotById = new Map(shots.map((s) => [s.id, s]));
  const fps = timeline.fps;
  const W = timeline.width;
  const H = timeline.height;

  if (!Number.isInteger(fps) || fps <= 0) add('MV-SCHEMA', 'block', 'timeline.fps must be a positive integer');
  if (!Number.isInteger(W) || !Number.isInteger(H)) add('MV-SCHEMA', 'block', 'timeline.width/height must be integers');
  if (!shots.length) add('MV-SCHEMA', 'block', 'timeline has no shots');
  const ids = [...shots.map((s) => s.id), ...(timeline.text || []).map((t) => t.id), ...(timeline.voice || []).map((v) => v.id)];
  for (const id of ids.filter((id, i) => ids.indexOf(id) !== i)) add('MV-SCHEMA', 'block', `duplicate id ${id}`);

  // Assets: kind, integrity, restriction, privacy, rights.
  for (const asset of assets.values()) {
    const methods = ASSET_KINDS[asset.kind];
    if (!methods) add('MV-KIND', 'block', `asset ${asset.id}: unknown kind ${asset.kind}`);
    else if (!methods.includes(asset.captureMethod)) add('MV-KIND', 'block', `asset ${asset.id}: kind ${asset.kind} cannot come from capture method ${asset.captureMethod}`);
    if (asset.kind === 'generated' && !asset.provenance?.provider) add('MV-KIND', 'block', `asset ${asset.id}: a generated asset must name its provider`);
    const info = fileInfo(asset.file);
    if (!info.deliverable) add('MV-RESTRICTED', 'block', `asset ${asset.id}: ${info.reason}`);
    else if (info.sha256 !== asset.sha256) add('MV-ASSET-HASH', 'block', `asset ${asset.id}: file hash differs from manifest`);
    const s = asset.sensitivity || {};
    if (!SENSITIVITY_OK.has(s.status)) add('MV-PRIV', 'block', `asset ${asset.id}: sensitivity is ${s.status || 'unreviewed'}`);
    else if (s.reviewedSha256 !== asset.sha256) add('MV-PRIV', 'block', `asset ${asset.id}: privacy review was for different bytes`);
    if (asset.rights?.commercialUse !== 'yes') add('MV-RIGHTS', 'draft', `asset ${asset.id}: commercial use is ${asset.rights?.commercialUse || 'unknown'}`);
  }
  for (const [name, rights] of Object.entries(project.toolRights || {})) {
    if (rights?.commercialUse !== 'yes') add('MV-RIGHTS', 'draft', `tool ${name}: commercial use is ${rights?.commercialUse || 'unknown'}`);
  }
  if (!project.toolRights?.remotion) add('MV-RIGHTS', 'draft', 'tool remotion: license status not recorded');

  // Spend: every cost needs a live user approval for that provider and unit,
  // and the costs charged to one approval must fit its cap.
  const charged = new Map();
  for (const asset of assets.values()) {
    const cost = asset.provenance?.cost;
    if (!cost || !(cost.amount > 0)) continue;
    const approval = approvalById.get(asset.provenance.approvalId);
    const why = !approval ? 'no approval recorded'
      : approval.decidedBy !== 'user' ? `approval ${approval.id} was not decided by the user`
      : approval.type !== 'spend' ? `approval ${approval.id} is not a spend approval`
      : approval.status !== 'active' ? `approval ${approval.id} is ${approval.status || 'without status'}`
      : approval.expires !== undefined && !(Date.parse(approval.expires) >= now.getTime()) ? `approval ${approval.id} is expired or has no valid expiry date`
      : approval.provider !== asset.provenance.provider ? `approval ${approval.id} covers provider ${approval.provider}, not ${asset.provenance.provider}`
      : approval.unit !== cost.unit ? `approval ${approval.id} is in ${approval.unit}, cost is in ${cost.unit}`
      : null;
    if (why) { add('MV-COST', 'block', `asset ${asset.id}: ${cost.amount} ${cost.unit} — ${why}`); continue; }
    charged.set(approval.id, (charged.get(approval.id) || 0) + cost.amount);
  }
  for (const approval of approvalList) {
    for (const k of ['cap', 'reserved', 'consumed']) {
      if (approval.type === 'spend' && approval[k] !== undefined && !(Number.isFinite(approval[k]) && approval[k] >= 0)) add('MV-COST', 'block', `approval ${approval.id}: ${k} must be a non-negative number`);
    }
    if (approval.expires !== undefined && Number.isNaN(Date.parse(approval.expires))) add('MV-COST', 'block', `approval ${approval.id}: expires is not a date`);
    if (approval.status === 'needs-reconciliation') add('MV-COST', 'block', `approval ${approval.id} needs reconciliation before any further spend`);
    if (approval.type !== 'spend') continue;
    const used = Math.max(charged.get(approval.id) || 0, approval.consumed || 0) + (approval.reserved || 0);
    if (typeof approval.cap !== 'number') add('MV-COST', 'block', `approval ${approval.id} has no numeric cap`);
    else if (used > approval.cap) add('MV-COST', 'block', `approval ${approval.id}: ${used} ${approval.unit} charged or reserved exceeds cap ${approval.cap}`);
  }

  // Claims: verified, with evidence that resolves.
  for (const claim of claimById.values()) {
    if (claim.status !== 'verified') continue;
    const evidence = claim.evidence || [];
    if (!evidence.length) add('MV-CLAIM', 'block', `claim ${claim.id}: verified without evidence`);
    for (const [i, e] of evidence.entries()) {
      const where = `claim ${claim.id} evidence ${i + 1}`;
      if (!norm(e.excerpt)) add('MV-CLAIM', 'block', `${where}: needs an excerpt saying what the evidence shows`);
      if (e.type === 'asset') {
        const a = assets.get(e.ref);
        if (!a) add('MV-CLAIM', 'block', `${where}: asset ${e.ref} is not in the manifest`);
        else if (e.sha256 !== a.sha256) add('MV-CLAIM', 'block', `${where}: evidence hash does not match asset ${a.id}`);
        else {
          const r = e.region;
          if (r && !(['x', 'y', 'w', 'h'].every((k) => Number.isFinite(r[k])) && r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0
            && (!a.media?.width || (r.x + r.w <= a.media.width && r.y + r.h <= a.media.height)))) add('MV-CLAIM', 'block', `${where}: region is not a positive rectangle inside asset ${a.id}`);
          if (e.time !== undefined) {
            const still = !(a.media?.durationSec > 0);
            if (still) add('MV-CLAIM', 'block', `${where}: a time was given for still asset ${a.id}`);
            else if (!(Number.isFinite(e.time) && e.time >= 0 && e.time <= a.media.durationSec)) add('MV-CLAIM', 'block', `${where}: time ${e.time} lies outside recording ${a.id}`);
          }
        }
      } else if (e.type === 'doc') {
        if (!norm(e.ref) || !(SHA.test(e.sha256 || '') || norm(e.excerpt).length >= 20)) add('MV-CLAIM', 'block', `${where}: a document needs a reference and a content hash or a quoted excerpt`);
      } else if (e.type === 'user') {
        if (!norm(e.ref)) add('MV-CLAIM', 'block', `${where}: user evidence needs the user's words in ref`);
      } else add('MV-CLAIM', 'block', `${where}: type must be asset, doc or user`);
    }
  }

  // Shots: references, truthfulness of motion, framing of the highlighted target.
  for (const shot of shots) {
    if (!Number.isInteger(shot.durationFrames) || shot.durationFrames <= 0) add('MV-SCHEMA', 'block', `shot ${shot.id}: durationFrames must be a positive integer`);
    for (const field of SYNTHETIC_INTERACTION) {
      if (shot[field] !== undefined) add('MV-TRUTH-INTERACTION', 'block', `shot ${shot.id}: synthetic "${field}" is never drawn; show real interaction with a recording`);
    }
    if (shot.assetId == null) {
      if (!shot.card) add('MV-SCHEMA', 'block', `shot ${shot.id}: needs an assetId or a card`);
      continue;
    }
    const asset = assets.get(shot.assetId);
    if (!asset) { add('MV-REF', 'block', `shot ${shot.id}: unknown asset ${shot.assetId}`); continue; }
    if (!['recording', 'screenshot', 'generated', 'logo'].includes(asset.kind)) { add('MV-REF', 'block', `shot ${shot.id}: asset ${asset.id} of kind ${asset.kind} is not visual`); continue; }
    const h = shot.highlight;
    const dims = asset.media?.width && asset.media?.height ? { width: asset.media.width, height: asset.media.height } : null;
    if (h && dims && (h.x < 0 || h.y < 0 || h.x + h.w > dims.width || h.y + h.h > dims.height)) {
      add('MV-SCHEMA', 'block', `shot ${shot.id}: highlight lies outside the asset`);
    } else if (h && dims && Number.isInteger(W) && Number.isInteger(shot.durationFrames)) {
      // From the moment the highlight appears, the target must sit wholly
      // inside the safe area and clear of the caption and label bands.
      const zone = { ...DEFAULT_ZONE, ...(project.exportPresets?.[timeline.preset || 'reel']?.safeZone || {}) };
      const hasCaption = (timeline.text || []).some((t) => t.shotId === shot.id && t.kind === 'caption');
      const area = contentArea(timeline, zone, { hasCaption });
      // Check from the earliest of: the highlight appearing, or any caption or
      // voice line in the shot starting (a line may name the target first).
      const lines = [...(timeline.text || []), ...(timeline.voice || [])].filter((t) => t.shotId === shot.id).map((t) => t.startFrame || 0);
      const from = Math.min(Math.round(shot.durationFrames * 0.2), ...lines);
      for (let f = from; f < shot.durationFrames; f += 1) {
        const r = onScreen(h, cameraBox(dims, W, H, camAt(shot, f)));
        if (r.x < area.left - 0.5 || r.y < area.top - 0.5 || r.x + r.w > area.right + 0.5 || r.y + r.h > area.bottom + 0.5) {
          add('MV-FRAMING', 'block', `shot ${shot.id}: at shot frame ${f} the highlighted target (${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}x${Math.round(r.h)}) leaves the clear area ${JSON.stringify(area)}; change the zoom, focus point or moveFrames`);
          break;
        }
      }
    }
  }

  // Authored words: every item is classified; factual items need verified claims.
  const prohibited = (project.prohibitedClaims || []).map((p) => p.toLowerCase()).filter(Boolean);
  const authored = [
    ...(timeline.text || []).map((t) => ({ ...t, where: `text ${t.id}` })),
    ...(timeline.voice || []).map((v) => ({ ...v, where: `voice ${v.id}` })),
  ];
  for (const item of authored) {
    if (!shotById.has(item.shotId)) { add('MV-REF', 'block', `${item.where}: unknown shot ${item.shotId}`); continue; }
    if (!TEXT_CLASSES.has(item.class)) add('MV-TRUTH-CLASS', 'block', `${item.where}: class must be one of ${[...TEXT_CLASSES].join(', ')}`);
    for (const p of prohibited) if (String(item.text || '').toLowerCase().includes(p)) add('MV-PROHIBITED', 'block', `${item.where}: contains prohibited claim "${p}"`);
    if (item.class === 'factual') {
      const claim = claimById.get(item.claimId);
      if (!claim) add('MV-CLAIM', 'block', `${item.where}: factual text needs a claimId in claims.json`);
      else if (claim.status !== 'verified' || !(claim.evidence || []).length) add('MV-CLAIM', 'block', `${item.where}: claim ${claim.id} is not verified with evidence`);
    }
    if (item.class === 'conceptual') {
      const asset = assets.get(shotById.get(item.shotId).assetId);
      if (asset && REAL_PIXELS.has(asset.kind)) add('MV-CONCEPT', 'block', `${item.where}: conceptual text may not sit on real product or brand pixels`);
    }
  }
  const disclosure = timeline.disclosure;
  if (disclosure) {
    const text = String(disclosure.text || '');
    if (!norm(text) || text.length > 60) add('MV-DISCLOSURE', 'block', 'disclosure must be a short, non-empty label (60 characters at most)');
    // The disclosure is never free text: it is one of the project's approved
    // labels, so it cannot carry an unclassified claim.
    else if (!(project.disclosureLabels || []).includes(text)) add('MV-DISCLOSURE', 'block', `disclosure "${text}" is not one of project.json disclosureLabels`);
    for (const p of prohibited) if (text.toLowerCase().includes(p)) add('MV-PROHIBITED', 'block', `disclosure contains prohibited claim "${p}"`);
  }

  // Timing: captions inside their shot, readable, not overlapping; voice fits
  // its shot, says what the timeline says, and is captioned.
  const spans = new Map(shotSpans(timeline).map((s) => [s.id, s]));
  const captionsAbs = [];
  for (const t of timeline.text || []) {
    const shot = shotById.get(t.shotId);
    if (!shot) continue;
    if (!(t.startFrame >= 0 && t.endFrame <= shot.durationFrames && t.endFrame > t.startFrame)) {
      add('MV-TIMING', 'block', `text ${t.id}: frames ${t.startFrame}-${t.endFrame} fall outside shot ${shot.id}`);
      continue;
    }
    if (fps && t.endFrame - t.startFrame < Math.round(MIN_CAPTION_SEC * fps)) add('MV-TIMING', 'block', `text ${t.id}: shown for under ${MIN_CAPTION_SEC}s`);
    if (t.kind === 'caption') captionsAbs.push({ id: t.id, lang: t.lang || '', s: spans.get(t.shotId).start + t.startFrame, e: spans.get(t.shotId).start + t.endFrame });
  }
  const byLang = {};
  for (const c of captionsAbs) (byLang[c.lang] ||= []).push(c);
  for (const list of Object.values(byLang)) {
    list.sort((a, b) => a.s - b.s);
    for (let i = 1; i < list.length; i += 1) {
      if (list[i].s < list[i - 1].e) add('MV-TIMING', 'block', `captions ${list[i - 1].id} and ${list[i].id} overlap`);
    }
  }
  for (const v of timeline.voice || []) {
    const shot = shotById.get(v.shotId);
    const asset = assets.get(v.assetId);
    if (!asset) { add('MV-REF', 'block', `voice ${v.id}: unknown asset ${v.assetId}`); continue; }
    if (asset.kind !== 'voice') { add('MV-REF', 'block', `voice ${v.id}: asset ${asset.id} is not a voice asset`); continue; }
    const spoken = asset.provenance?.text;
    if (spoken === undefined) add('MV-VOICE-TEXT', 'block', `voice ${v.id}: asset ${asset.id} does not record the words it speaks`);
    else if (norm(spoken) !== norm(v.text)) add('MV-VOICE-TEXT', 'block', `voice ${v.id}: the timeline text differs from what asset ${asset.id} actually says`);
    // Words typed in for a downloaded take are a record, not a measurement:
    // until someone who listened confirms them, the output stays a draft.
    else if (asset.captureMethod === 'provided' && asset.provenance?.textVerifiedBy !== 'user') add('MV-VOICE-TEXT', 'draft', `voice ${v.id}: nobody has confirmed by listening that asset ${asset.id} says these words`);
    if (shot && fps && (v.startFrame || 0) + voiceFrames(asset, fps) > shot.durationFrames) {
      add('MV-TIMING', 'block', `voice ${v.id}: ${asset.media?.durationSec}s of audio does not fit shot ${shot.id}; lengthen the shot or shorten the line`);
    }
    // The words must be on screen for (nearly) the whole time they are spoken.
    const vs = v.startFrame || 0;
    const ve = vs + (fps ? voiceFrames(asset, fps) : 0);
    const covered = (timeline.text || []).filter((t) => t.shotId === v.shotId && norm(t.text) === norm(v.text))
      .reduce((best, t) => Math.max(best, Math.max(0, Math.min(ve, t.endFrame) - Math.max(vs, t.startFrame))), 0);
    if (shot && ve > vs && covered / (ve - vs) < 0.9) add('MV-CAPTIONS', 'block', `voice ${v.id}: the spoken words are on screen for ${Math.round((100 * covered) / (ve - vs))}% of the line (90% required)`);
  }

  const blocked = findings.some((f) => f.severity === 'block');
  const draft = findings.some((f) => f.severity === 'draft');
  return { status: blocked ? 'blocked' : 'pass', deliveryStatus: blocked ? 'blocked' : draft ? 'draft' : 'final-eligible', findings };
}
