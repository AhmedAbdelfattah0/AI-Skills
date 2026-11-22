#!/usr/bin/env node
/**
 * plan-sync.mjs (S3b-B1): a READ-ONLY check that the repo plan artifact still says what the approved native plan says.
 *
 *   node plan-sync.mjs check --native <file> --plan <artifact> [--approved <sha256:hex>]
 *
 * Two shapes of native file (PLAN-S3b package, B1):
 *  1. The native file has RUN-STATE markers: planDigest(native) must equal planDigest(artifact) (brief.mjs, the engine's
 *     planNarrativeDigest: RUN-STATE body excluded, markers kept, no line-end or BOM normalisation).
 *  2. The native file has no markers: the artifact text BEFORE the BEGIN marker (minus exactly one trailing LF) plus the text
 *     AFTER the END marker must equal the native bytes exactly. No CRLF or BOM normalisation, so a CRLF or BOM native file differs.
 *
 * One JSON line on stdout. In sync: { in_sync: true, native_sha256, narrative_digest [, approved_match] }. Stale: the same with
 * in_sync false, code 'plan_sync_stale' and first_difference { line, native, artifact } (each side trimmed to 200 chars, null
 * when that side has no such line). Refused or unsupported: { in_sync: false, code, reason, which }.
 * Exit 0 in sync, 1 stale (plan_sync_stale), 2 refused input (usage, unreadable, symlink, not regular, oversize, plan_invalid,
 * malformed --approved), 3 plan_sync_unsupported (a wave file, D9: single ticket only; never parses Markdown sections).
 *
 * This tool grants NO authority. It reads no RUN-STATE event, writes no file, opens no network connection and starts no process.
 * Files are opened O_RDONLY | O_NOFOLLOW | O_NONBLOCK after an lstat, and capped at 1 MiB.
 */
import { createHash } from 'node:crypto';
import { lstatSync, openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';
import { planDigest } from './brief.mjs';
import { isEntrypoint } from './harness.mjs';

export const MAX_BYTES = 1024 * 1024;
const USAGE = 'usage: plan-sync.mjs check --native <native plan file> --plan <repo plan artifact> [--approved <sha256:hex>]';
const BEGIN = '<!-- RUN-STATE:BEGIN -->', END = '<!-- RUN-STATE:END -->';
const LINE_CAP = 200;
const refusal = (reason, which) => Object.assign(new Error(reason), { refused: true, reason, which });

/** Read one plan file as utf8 (same decoding as readFileSync 'utf8': no BOM or line-end change). */
export function readPlan(path, which) {
  let l;
  try { l = lstatSync(path); } catch { throw refusal('unreadable', which); }
  if (l.isSymbolicLink()) throw refusal('symlink', which);
  if (!l.isFile()) throw refusal('not_regular', which);
  if (l.size > MAX_BYTES) throw refusal('oversize', which);
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile()) throw refusal('not_regular', which);
    if (st.size > MAX_BYTES) throw refusal('oversize', which);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString('utf8');
  } catch (err) {
    if (err.refused) throw err;
    throw refusal(err.code === 'ELOOP' ? 'symlink' : 'unreadable', which);
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* read-only descriptor */ }
  }
}

/** The narrowest wave test: a Markdown heading line that starts with the word Wave (references/plan.md "Waves"). */
const WAVE_HEADING = /^#{1,6}[ \t]+wave\b/im;
const sha256 = (text) => `sha256:${createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')}`;

/** The artifact's single RUN-STATE block: exactly one BEGIN and one END, in order; anything else is plan_invalid. */
function artifactBlock(text) {
  const b = text.indexOf(BEGIN), e = text.indexOf(END);
  const once = (m) => text.indexOf(m) === text.lastIndexOf(m);
  if (b < 0 || e < b || !once(BEGIN) || !once(END)) throw refusal('plan_invalid', 'artifact');
  return { b, e };
}

const trimLine = (l) => {
  if (l === undefined) return null;
  const t = l.trim();
  return t.length > LINE_CAP ? `${t.slice(0, LINE_CAP)}...` : t;
};

/** First line (1-based) at which two texts differ, split on LF only (a CR stays part of its line), each side bounded. */
export function firstDifference(a, b) {
  const x = a.split('\n'), y = b.split('\n');
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if (x[i] !== y[i]) return { line: i + 1, native: trimLine(x[i]), artifact: trimLine(y[i]) };
  }
  return { line: 0, native: null, artifact: null };
}

/** Pure comparison. Throws a refusal (plan_invalid) or an unsupported error (wave file). */
export function comparePlans(nativeText, artifactText, approved) {
  for (const [which, text] of [['native', nativeText], ['artifact', artifactText]]) {
    if (WAVE_HEADING.test(text)) throw Object.assign(new Error('wave_plan'), { unsupported: true, reason: 'wave_plan', which });
  }
  if (approved !== undefined && !/^sha256:[0-9a-f]{64}$/.test(approved)) throw refusal('approved_malformed', 'approved');
  const { b, e } = artifactBlock(artifactText);
  const narrative_digest = planDigest(artifactText);
  const nativeMarked = nativeText.includes(BEGIN) || nativeText.includes(END);
  let inSync, nativeNarrative, diff;
  if (nativeMarked) {
    let d;
    try { d = planDigest(nativeText); } catch { throw refusal('plan_invalid', 'native'); }
    const nb = nativeText.indexOf(BEGIN), ne = nativeText.indexOf(END);
    if (nativeText.lastIndexOf(BEGIN) !== nb || nativeText.lastIndexOf(END) !== ne) throw refusal('plan_invalid', 'native');
    nativeNarrative = d;
    inSync = d === narrative_digest;
    if (!inSync) diff = firstDifference(nativeText.slice(0, nb + BEGIN.length) + nativeText.slice(ne), artifactText.slice(0, b + BEGIN.length) + artifactText.slice(e));
  } else {
    const before = artifactText.slice(0, b);
    const expected = (before.endsWith('\n') ? before.slice(0, -1) : before) + artifactText.slice(e + END.length);
    inSync = expected === nativeText;
    nativeNarrative = inSync ? narrative_digest : null;
    if (!inSync) diff = firstDifference(nativeText, expected);
  }
  const out = { in_sync: inSync, native_sha256: sha256(nativeText), narrative_digest };
  if (!inSync) { out.code = 'plan_sync_stale'; out.first_difference = diff; }
  if (approved !== undefined) out.approved_match = nativeNarrative === approved;
  return out;
}

function parseArgs(argv) {
  const o = {};
  const [cmd, ...rest] = argv;
  if (cmd !== 'check') throw Object.assign(new Error('the first argument must be the command: check'), { usage: true });
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--native' || a === '--plan' || a === '--approved') {
      const k = a.slice(2);
      if (o[k] !== undefined) throw Object.assign(new Error(`${a} given twice`), { usage: true });
      if (i + 1 >= rest.length) throw Object.assign(new Error(`${a} needs a value`), { usage: true });
      o[k] = rest[i + 1]; i += 1; // the value is taken verbatim, even when it starts with '-'
      continue;
    }
    throw Object.assign(new Error(`unknown argument ${JSON.stringify(a)}`), { usage: true });
  }
  if (!o.native || !o.plan) throw Object.assign(new Error('--native and --plan are both required'), { usage: true });
  return o;
}

export function main(argv, out = process.stdout, err = process.stderr) {
  let o;
  try { o = parseArgs(argv); } catch (e) {
    if (!e.usage) throw e;
    err.write(`plan-sync: ${e.message}\n${USAGE}\n`);
    return 2;
  }
  try {
    const r = comparePlans(readPlan(o.native, 'native'), readPlan(o.plan, 'artifact'), o.approved);
    out.write(`${JSON.stringify(r)}\n`);
    return r.in_sync ? 0 : 1;
  } catch (e) {
    if (e.unsupported) { out.write(`${JSON.stringify({ in_sync: false, code: 'plan_sync_unsupported', reason: e.reason, which: e.which })}\n`); return 3; }
    if (!e.refused) throw e;
    out.write(`${JSON.stringify({ in_sync: false, code: e.reason, reason: e.reason, which: e.which })}\n`);
    return 2;
  }
}

if (isEntrypoint(import.meta.url)) process.exitCode = main(process.argv.slice(2));
